import crypto from "node:crypto";
import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import {
  extractTemplateReference,
  parseTemplateManagementMessage,
} from "./attendance-templates.mjs";
import { buildMeetingCommand } from "./commands.mjs";
import {
  buildDirectConfirmationPayload,
  buildDraftPayload,
  buildMeetingPayload,
  buildMeetingUrlModal,
} from "./discord-ui.mjs";
import { parseGuildNaturalCommand } from "./local-command-router.mjs";
import {
  extractMeetingIds,
  normalizeMeetingId,
  redactMeetingIds,
} from "./meeting-id.mjs";
import { MeetingTargetResolver } from "./meeting-target-resolver.mjs";
import { resolveMeetingUrl } from "./meeting-url-resolver.mjs";
import { discordVoiceChannelUrl } from "./meeting-venue.mjs";
import { resolveParticipantSnapshot } from "./participant-resolution.mjs";
import { MAX_TEMPLATE_MEMBERS } from "./storage/attendance-template-repository.mjs";
import {
  extractKnownMemberAliases,
  extractParticipantDirective,
  parseMemberAliasList,
  redactKnownMemberAliases,
} from "./participants.mjs";
import { formatPersonalReminderMinutes, parsePersonalReminderRequest } from "./personal-reminders.mjs";
import {
  assertSafeForAi,
  extractAndRedactSensitiveText,
  normalizeMeetingUrl,
  safeDisplayText,
} from "./privacy.mjs";
import { SelfServiceController } from "./self-service-controller.mjs";
import {
  discordTimestamp,
  normalizeReminderMinutes,
  parseJstDateTime,
  reminderLabel,
} from "./time.mjs";

const MISSING_LABELS = {
  title: "会議名",
  startsAt: "開始日時",
  durationMinutes: "会議時間",
  reminderMinutes: "通知時刻",
  meetingUrl: "会議URL",
  meetingId: "会議ID",
  requestedChanges: "変更内容",
};
const RSVP_LABELS = { attending: "参加", maybe: "未定", declined: "欠席" };
const MAX_MEETING_INVITEES = MAX_TEMPLATE_MEMBERS;
const CALENDAR_INVITATION_HOSTS = new Set(["calendar.app.google", "calendar.google.com"]);

function normalizeMeetingReminders(values, fallback) {
  if (Array.isArray(values) && values.length === 0) return [];
  return normalizeReminderMinutes(values, fallback);
}

export function formatMeetingListContent(meetings, { maxLength = 1_900 } = {}) {
  if (!meetings.length) return "開催予定の会議はありません。";
  const lines = meetings.map((meeting) => (
    `• **${meeting.id}** ${safeDisplayText(meeting.title, 80)} — ${discordTimestamp(meeting.startsAtMs, "F")}`
  ));
  const selected = [];
  for (let index = 0; index < lines.length; index += 1) {
    const remaining = lines.length - index - 1;
    const suffix = remaining > 0 ? `\n…ほか${remaining}件` : "";
    const candidate = [...selected, lines[index]].join("\n");
    if (`${candidate}${suffix}`.length > maxLength) break;
    selected.push(lines[index]);
  }
  const remaining = lines.length - selected.length;
  return `${selected.join("\n")}${remaining > 0 ? `\n…ほか${remaining}件` : ""}`;
}

function shortErrorCode(error) {
  return String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
}

function urlHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isCalendarInvitationUrl(value) {
  return CALENDAR_INVITATION_HOSTS.has(urlHostname(value));
}

function chooseOneMeetingUrl(values) {
  const candidates = [...new Set(values.filter(Boolean))];
  if (candidates.length > 1) {
    throw new Error("会議URLが複数あり、1つに決められませんでした。使う会議URLを1つだけ送ってください");
  }
  return candidates[0] || null;
}

function automaticMeetingTitle(startsAtMs, timeZone = "Asia/Tokyo") {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(startsAtMs));
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return `会議 ${value("month")}/${value("day")} ${value("hour")}:${value("minute")}`;
}

function displayName(subject) {
  return safeDisplayText(
    subject.member?.displayName
      || subject.member?.nickname
      || subject.user?.globalName
      || subject.user?.username
      || subject.author?.globalName
      || subject.author?.username
      || "Discordユーザー",
    80,
  );
}

function discordUserDisplayName(user, member = null) {
  return safeDisplayText(
    member?.displayName
      || member?.nickname
      || user?.globalName
      || user?.username
      || "Discordユーザー",
    80,
  );
}

export class MeetingCoordinator {
  constructor({
    client,
    store,
    interpreter,
    sheetsSync,
    config,
    directMessenger = null,
    directInviteUpdateScheduler = null,
    meetingCardUpdateScheduler = null,
    voiceMeetingController = null,
    meetingUrlResolver = resolveMeetingUrl,
    logger = console,
  }) {
    this.client = client;
    this.store = store;
    this.interpreter = interpreter;
    this.sheetsSync = sheetsSync;
    this.config = config;
    this.attendeeMentionOffsets = config.attendeeMentionOffsets ?? config.everyoneOffsets ?? [0];
    this.directMessenger = directMessenger;
    this.directInviteUpdateScheduler = directInviteUpdateScheduler;
    this.meetingCardUpdateScheduler = meetingCardUpdateScheduler;
    this.voiceMeetingController = voiceMeetingController;
    this.meetingUrlResolver = meetingUrlResolver;
    this.logger = logger;
    this.drafts = new Map();
    this.meetingTargets = new MeetingTargetResolver({ store });
    this.selfService = new SelfServiceController({
      store,
      guildId: config.guildId,
      refreshMeetingCard: (...args) => this.refreshMeetingCard(...args),
      sheetsSync,
      logger,
    });
  }

  async registerCommands() {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    await guild.commands.set([buildMeetingCommand().toJSON()]);
  }

  canManage(subject) {
    const permissions = subject.memberPermissions || subject.member?.permissions;
    if (permissions?.has?.(PermissionFlagsBits.ManageGuild) || permissions?.has?.(PermissionFlagsBits.ManageEvents)) {
      return true;
    }
    const configuredRoles = new Set(this.config.creatorRoleIds);
    if (!configuredRoles.size) return false;
    const cache = subject.member?.roles?.cache;
    if (cache?.some?.((role) => configuredRoles.has(role.id))) return true;
    const roleIds = Array.isArray(subject.member?.roles) ? subject.member.roles : [];
    return roleIds.some((roleId) => configuredRoles.has(String(roleId)));
  }

  async requireManager(subject, reply) {
    if (this.canManage(subject)) return true;
    await reply("この操作はサーバー管理者または会議管理ロールだけが使えます。");
    return false;
  }

  async canViewMeeting(subject, meeting) {
    if (!meeting || meeting.guildId !== String(subject?.guildId ?? "")) return false;
    if (String(subject?.channelId ?? "") === String(meeting.channelId)) return true;
    try {
      const channel = await this.client.channels.fetch(meeting.channelId);
      let member = subject.member || null;
      if (!member) {
        const userId = subject.user?.id || subject.author?.id;
        const guild = await this.client.guilds.fetch(meeting.guildId);
        member = await guild.members.fetch(String(userId));
      }
      return Boolean(channel?.permissionsFor?.(member)?.has?.(PermissionFlagsBits.ViewChannel));
    } catch {
      return false;
    }
  }

  async visibleUpcomingMeetings(subject, { limit = 20, sameChannelOnly = false } = {}) {
    const meetings = this.store.listUpcoming(subject.guildId, { limit: 100 });
    const visible = [];
    for (const meeting of meetings) {
      if (sameChannelOnly && String(meeting.channelId) !== String(subject.channelId)) continue;
      if (await this.canViewMeeting(subject, meeting)) visible.push(meeting);
      if (visible.length >= limit) break;
    }
    return visible;
  }

  async visibleMeetingTarget(subject, result, { sameChannelOnly = false } = {}) {
    const candidates = result?.status === "resolved"
      ? [result.meeting]
      : (result?.candidates || []);
    const visible = [];
    for (const meeting of candidates) {
      if (sameChannelOnly && String(meeting.channelId) !== String(subject?.channelId)) continue;
      if (await this.canViewMeeting(subject, meeting)) visible.push(meeting);
    }
    if (visible.length === 1) {
      return { status: "resolved", via: result?.via || null, meeting: visible[0], candidates: visible };
    }
    if (visible.length > 1) return { status: "ambiguous", candidates: visible };
    return { status: "not_found", candidates: [] };
  }

  cleanupDrafts() {
    const now = Date.now();
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAtMs <= now) this.drafts.delete(id);
    }
  }

  createDraft(value) {
    this.cleanupDrafts();
    const draftId = crypto.randomBytes(9).toString("base64url");
    const draft = { ...value, draftId, expiresAtMs: Date.now() + 10 * 60_000 };
    this.drafts.set(draftId, draft);
    return draft;
  }

  async resolveSubmittedMeetingUrl(rawUrls) {
    const normalized = [...new Set((rawUrls || []).map((value) => normalizeMeetingUrl(value)))];
    if (!normalized.length) throw new Error("会議URLを1つ送ってください");

    const resolved = [];
    for (const value of normalized) {
      resolved.push(normalizeMeetingUrl(await this.meetingUrlResolver(value)));
    }
    return chooseOneMeetingUrl(resolved);
  }

  meetingTargetCandidatesText(result) {
    const candidates = result?.candidates || [];
    return [
      "更新する会議を1つに絞れませんでした。次のどれかの会議カードへ返信して、同じ内容を送ってください。",
      ...candidates.map((meeting) => `• **${safeDisplayText(meeting.title, 70)}** — ${discordTimestamp(meeting.startsAtMs, "F")}`),
    ].join("\n");
  }

  async createNaturalUrlUpdateDraft(message, rawText, replyText) {
    let extracted;
    try {
      extracted = extractAndRedactSensitiveText(rawText);
    } catch {
      throw new Error("URLを安全に読み取れませんでした。会議URLを1つだけ送ってください");
    }
    if (!extracted.urls.length) throw new Error("新しい会議URLまたはGoogleカレンダーの招待URLを送ってください");

    const target = await this.visibleMeetingTarget(message, this.meetingTargets.resolve({
      guildId: message.guildId,
      channelId: message.channelId,
      authorId: message.author.id,
      rawText,
      replyMessageId: message.reference?.messageId || null,
    }), { sameChannelOnly: true });
    if (target.status === "ambiguous") {
      await replyText(this.meetingTargetCandidatesText(target));
      return;
    }
    if (target.status !== "resolved") {
      await replyText("更新する会議を見つけられませんでした。会議カードへ返信するか、会議名を含めてもう一度送ってください。");
      return;
    }

    const meetingUrl = await this.resolveSubmittedMeetingUrl(extracted.urls);
    const meeting = target.meeting;
    const draft = this.createDraft({
      action: "update",
      meetingId: meeting.id,
      guildId: meeting.guildId,
      channelId: meeting.channelId,
      creatorId: message.author.id,
      creatorName: displayName(message),
      title: meeting.title,
      startsAtMs: meeting.startsAtMs,
      endsAtMs: meeting.endsAtMs,
      reminderMinutes: meeting.reminderMinutes,
      meetingUrl,
      urlOnly: true,
      baseUpdatedAtMs: meeting.updatedAtMs,
      changedFields: ["meetingUrl"],
    });
    const preview = await message.reply({
      ...buildDraftPayload(draft),
      allowedMentions: { parse: [], repliedUser: false },
    });
    draft.previewMessageId = preview.id;
  }

  async repairActiveInvitationUrls({ limit = 10, maxDurationMs = 45_000 } = {}) {
    let repaired = 0;
    let failed = 0;
    let skippedByDeadline = 0;
    const deadline = Date.now() + Math.max(1_000, Number(maxDurationMs) || 45_000);
    const meetings = this.store.listUpcoming(this.config.guildId, { limit });
    for (const meeting of meetings) {
      if (!isCalendarInvitationUrl(meeting.meetingUrl)) continue;
      if (Date.now() >= deadline) {
        skippedByDeadline += 1;
        continue;
      }
      try {
        const directUrl = await this.resolveSubmittedMeetingUrl([meeting.meetingUrl]);
        const updated = this.store.updateMeetingUrlIfUnchanged(meeting.id, directUrl, {
          expectedUpdatedAtMs: meeting.updatedAtMs,
        });
        repaired += 1;
        await this.refreshExistingDirectInvites(updated);
        await this.refreshMeetingCard(updated).catch(() => {});
      } catch (error) {
        failed += 1;
        this.logger.warn(`[meeting-url] 招待URLの自動修復失敗 code=${shortErrorCode(error)}`);
      }
    }
    if (repaired) this.sheetsSync?.requestSync();
    return { repaired, failed, skippedByDeadline };
  }

  resolveInvitees({ guildId, aliases = [], users = [] }) {
    const resolved = this.store.resolveMemberAliases(guildId, aliases);
    if (resolved.missing.length) {
      throw new Error(`未登録の呼び名: ${resolved.missing.map((item) => safeDisplayText(item, 32)).join("、")}。先に /meeting member-add で登録してください`);
    }
    const invitees = [];
    const seen = new Set();
    const add = (invitee) => {
      const userId = String(invitee.userId);
      if (seen.has(userId)) return;
      if (userId === this.client.user?.id || invitee.bot) throw new Error("Bot自身や別のBotは招待できません");
      seen.add(userId);
      invitees.push({
        userId,
        displayName: safeDisplayText(invitee.displayName, 80),
      });
    };
    for (const member of resolved.found) {
      add({ userId: member.userId, displayName: member.displayName });
    }
    for (const user of users) {
      add({ userId: user.id, displayName: discordUserDisplayName(user), bot: user.bot });
    }
    if (invitees.length > MAX_MEETING_INVITEES) {
      throw new Error(`個別DMは1会議につき${MAX_MEETING_INVITEES}人までです`);
    }
    return invitees;
  }

  resolveParticipantSelection({
    guildId,
    explicitInvitees = [],
    explicitParticipantsFound = false,
    templateName = null,
    disableInvites = false,
    includeDefault = false,
  }) {
    const referencedTemplate = templateName
      ? this.store.attendanceTemplates.getTemplate(guildId, templateName)
      : null;
    if (templateName && !referencedTemplate) {
      throw new Error(`参加者テンプレート「${safeDisplayText(templateName, 40)}」が見つかりません`);
    }
    const defaultTemplate = includeDefault && !templateName && !disableInvites
      ? this.store.attendanceTemplates.getDefaultTemplate(guildId)
      : null;
    return resolveParticipantSnapshot({
      explicitInvitees,
      explicitParticipantsFound,
      referencedTemplate,
      defaultTemplate,
      disableInvites,
      maxInvitees: MAX_MEETING_INVITEES,
    });
  }

  participantSelectionFromOptions(interaction, { includeDefault = false, allowNoDm = false } = {}) {
    const aliasesRaw = interaction.options.getString("members") || "";
    const aliases = aliasesRaw ? parseMemberAliasList(aliasesRaw) : [];
    const users = [];
    for (let index = 1; index <= 5; index += 1) {
      const user = interaction.options.getUser(`user${index}`);
      if (user) users.push(user);
    }
    const explicitInvitees = this.resolveInvitees({ guildId: interaction.guildId, aliases, users });
    return this.resolveParticipantSelection({
      guildId: interaction.guildId,
      explicitInvitees,
      explicitParticipantsFound: Boolean(aliasesRaw.trim() || users.length),
      templateName: interaction.options.getString("template") || null,
      disableInvites: allowNoDm && Boolean(interaction.options.getBoolean("no_dm")),
      includeDefault,
    });
  }

  inviteesFromMention(message, rawText) {
    const knownTemplateNames = this.store.attendanceTemplates.listTemplates(message.guildId)
      .map((template) => template.name);
    const templateReference = extractTemplateReference(rawText, { knownTemplateNames });
    const registered = this.store.listMemberAliases(message.guildId);
    const knownAliases = registered.map((member) => member.alias);
    const directive = extractParticipantDirective(templateReference.cleanedText, { knownAliases });
    const detectedAliases = extractKnownMemberAliases(
      templateReference.cleanedText,
      knownAliases,
    );
    const users = [...message.mentions.users.values()]
      .filter((user) => user.id !== this.client.user?.id);
    return {
      cleanedText: directive.cleanedText,
      knownAliases,
      explicitInvitees: this.resolveInvitees({
        guildId: message.guildId,
        aliases: [...new Set([...directive.aliases, ...detectedAliases])],
        users,
      }),
      explicitParticipantsFound: Boolean(directive.found || detectedAliases.length || users.length),
      templateName: templateReference.templateName,
      disableInvites: directive.disableInvites,
    };
  }

  async handleMention(message, rawText) {
    const replyText = async (content) => message.reply({
      content,
      allowedMentions: { parse: [], repliedUser: false },
    });

    // 全英字の小文字IDは一般語との誤認を避けるため、ローカルに実在する
    // active IDだけを照合する。件数上限付きの一覧表示queryはprivacy gateに使わない。
    const knownMeetingIds = this.store.listActiveMeetingIds(message.guildId);
    const submittedMeetingIds = extractMeetingIds(rawText, { knownIds: knownMeetingIds });
    if (submittedMeetingIds.length > 1) {
      await replyText("会議IDが複数あります。更新する会議IDを1つだけ指定して、もう一度送ってください。内容はAIへ送信していません。");
      return;
    }

    let templateCommand;
    try {
      templateCommand = parseTemplateManagementMessage(rawText);
    } catch (error) {
      await replyText(safeDisplayText(error.message, 220));
      return;
    }
    if (templateCommand) {
      if (!(await this.requireManager(message, replyText))) return;
      await this.handleNaturalTemplateCommand(message, rawText, templateCommand, replyText);
      return;
    }

    const localCommand = parseGuildNaturalCommand(rawText, { knownMeetingIds });
    if (localCommand?.action === "voice_privacy") {
      await replyText(this.voiceMeetingController?.privacyText() || "VC文字起こし機能はまだ設定されていません。");
      return;
    }
    if (localCommand?.action === "voice_status") {
      await replyText(this.voiceMeetingController?.statusText(message) || "VC文字起こし機能はまだ設定されていません。");
      return;
    }
    if (localCommand?.action === "voice_stop") {
      if (!this.voiceMeetingController) {
        await replyText("VC文字起こし機能はまだ設定されていません。");
        return;
      }
      const userId = String(message.author?.id || "");
      const isParticipant = this.voiceMeetingController.session?.requiredUserIds?.has?.(userId);
      if (!this.canManage(message) && !isParticipant) {
        await replyText("現在のVC参加者または会議管理者だけが停止できます。");
        return;
      }
      const result = await this.voiceMeetingController.stopSession({ reason: "manual", requestedById: userId });
      await replyText(result.stopped ? `停止しました。セッション ${result.sessionId} の議事録を処理しています。` : "動作中のVC文字起こしはありません。");
      return;
    }
    if (["voice_start", "voice_reprocess", "voice_delete"].includes(localCommand?.action)) {
      if (!(await this.requireManager(message, replyText))) return;
      if (!this.voiceMeetingController) {
        await replyText("VC文字起こし機能はまだ設定されていません。");
        return;
      }
      if (localCommand.action === "voice_start") {
        const result = await this.voiceMeetingController.requestStart(message, { title: localCommand.title || "VCミーティング" });
        await replyText(`専用チャンネルで参加者全員の同意を確認します。セッション: ${result.sessionId}`);
      } else if (localCommand.action === "voice_reprocess") {
        const result = await this.voiceMeetingController.reprocess(localCommand.sessionId);
        await replyText(`セッション ${result.sessionId} の再処理を開始しました。`);
      } else {
        await this.voiceMeetingController.deleteSession(localCommand.sessionId);
        await replyText(`セッション ${localCommand.sessionId} のローカルバックアップを削除しました。`);
      }
      return;
    }
    if (localCommand?.action === "template_help") {
      await replyText(this.templateHelpText());
      return;
    }
    if (localCommand?.action === "help") {
      await replyText(this.helpText());
      return;
    }
    if (localCommand?.action === "meeting_list") {
      await this.replyMeetingList(message, replyText);
      return;
    }
    if (localCommand?.action === "meeting_status") {
      await this.replyMeetingStatus(message, localCommand.meetingId, message.reply.bind(message));
      return;
    }
    if (localCommand?.action === "my_reminders_show") {
      await this.selfService.showPreference(message);
      return;
    }

    if (await this.selfService.handleMessage(message, {
      requireExplicitTarget: true,
      rawText,
    })) return;

    if (localCommand) {
      if (!(await this.requireManager(message, replyText))) return;
      await this.handleNaturalManagerCommand(message, rawText, localCommand, replyText);
      return;
    }

    if (!(await this.requireManager(message, replyText))) return;
    if (!this.interpreter.configured) {
      await replyText("自然言語での会議作成・更新には会議AIプロバイダーの設定が必要です。設定までは `/meeting create` で登録できます。テンプレートや出欠はAIなしで利用できます。");
      return;
    }

    let participantInput;
    try {
      participantInput = this.inviteesFromMention(message, rawText);
    } catch (error) {
      await replyText(`招待メンバーを確認できませんでした: ${safeDisplayText(error.message, 220)}`);
      return;
    }

    let extracted;
    try {
      extracted = extractAndRedactSensitiveText(participantInput.cleanedText);
      extracted.sanitizedText = redactKnownMemberAliases(extracted.sanitizedText, participantInput.knownAliases);
      extracted.sanitizedText = redactMeetingIds(extracted.sanitizedText, submittedMeetingIds);
      assertSafeForAi(extracted.sanitizedText);
    } catch {
      await replyText("URLを安全に分離できなかったため処理を止めました。URLと会議内容を分けてもう一度送ってください。");
      return;
    }
    if (!extracted.sanitizedText) {
      await replyText(this.helpText());
      return;
    }

    let meetingUrl = null;
    if (extracted.urls.length) {
      try {
        meetingUrl = await this.resolveSubmittedMeetingUrl(extracted.urls);
      } catch (error) {
        await replyText(`会議URLを確認できませんでした: ${safeDisplayText(error.message, 220)}`);
        return;
      }
    }

    let interpretation;
    try {
      interpretation = await this.interpreter.interpret({
        sanitizedText: extracted.sanitizedText,
        hasMeetingUrl: Boolean(meetingUrl),
      });
    } catch (error) {
      this.logger.error(`[ai] 会議入力の整形に失敗 code=${shortErrorCode(error)}`);
      await replyText("会議内容のAI整形に失敗しました。URLはAIへ送信されていません。少し待つか `/meeting create` を使ってください。");
      return;
    }

    if (interpretation.action === "unknown") {
      await replyText(interpretation.clarification || `会議登録として解釈できませんでした。\n例: ${this.client.user} 来週月曜20:30から定例会議、URLは…`);
      return;
    }
    if (interpretation.action === "create" && !interpretation.title && interpretation.startsAtMs != null) {
      interpretation = {
        ...interpretation,
        title: automaticMeetingTitle(interpretation.startsAtMs, this.config.timeZone),
        autoTitle: true,
        missingFields: interpretation.missingFields.filter((field) => field !== "title"),
      };
    }
    // URL未定で登録した同じ会議へ、後から日時・会議名・URLをまとめて
    // 再送した場合は重複作成せずURL追記として扱う。対象照合はローカルだけで行う。
    if (interpretation.action === "create" && meetingUrl && interpretation.startsAtMs != null) {
      const existingTarget = await this.visibleMeetingTarget(message, this.meetingTargets.resolve({
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        rawText,
        replyMessageId: message.reference?.messageId || null,
      }), { sameChannelOnly: true });
      const canAttachToExisting = existingTarget.status === "resolved"
        && ["explicit_id", "reply", "title"].includes(existingTarget.via)
        && !String(existingTarget.meeting.meetingUrl ?? "").trim()
        && Math.abs(existingTarget.meeting.startsAtMs - interpretation.startsAtMs) <= 5 * 60_000;
      if (canAttachToExisting) {
        interpretation = {
          ...interpretation,
          action: "update",
          meetingId: existingTarget.meeting.id,
          title: null,
          startsAtMs: null,
          providedFields: ["meetingUrl"],
          missingFields: [],
        };
      }
    }
    if (interpretation.action === "update" && !interpretation.meetingId) {
      const target = await this.visibleMeetingTarget(message, this.meetingTargets.resolve({
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        rawText,
        replyMessageId: message.reference?.messageId || null,
      }), { sameChannelOnly: true });
      if (target.status === "ambiguous") {
        await replyText(this.meetingTargetCandidatesText(target));
        return;
      }
      if (target.status !== "resolved") {
        await replyText("更新する会議を見つけられませんでした。会議カードへ返信するか、会議名を含めてもう一度送ってください。");
        return;
      }
      interpretation = {
        ...interpretation,
        meetingId: target.meeting.id,
        missingFields: interpretation.missingFields.filter((field) => field !== "meetingId"),
      };
    }
    if (interpretation.action === "update" && interpretation.meetingId) {
      const targetMeeting = this.store.getMeeting(interpretation.meetingId);
      if (!targetMeeting
        || String(targetMeeting.channelId) !== String(message.channelId)
        || !(await this.canViewMeeting(message, targetMeeting))) {
        await replyText("更新する会議が見つかりませんでした。元の会議チャンネルで、もう一度送ってください。");
        return;
      }
    }
    if (interpretation.missingFields.length) {
      const fields = interpretation.missingFields.map((field) => MISSING_LABELS[field] || field).join("、");
      await replyText(`足りない項目: **${fields}**\n元の内容に足りない内容を足して、まとめてもう一度送ってください。`);
      return;
    }

    try {
      const participantSnapshot = this.resolveParticipantSelection({
        guildId: message.guildId,
        explicitInvitees: participantInput.explicitInvitees,
        explicitParticipantsFound: participantInput.explicitParticipantsFound,
        templateName: participantInput.templateName,
        disableInvites: participantInput.disableInvites,
        includeDefault: interpretation.action === "create",
      });
      const draft = interpretation.action === "create"
        ? this.buildCreateDraft({
          title: interpretation.title,
          startsAtMs: interpretation.startsAtMs,
          durationMinutes: interpretation.durationMinutes,
          reminderMinutes: interpretation.reminderMinutes,
          meetingUrl,
          autoTitle: Boolean(interpretation.autoTitle),
          guildId: message.guildId,
          channelId: message.channelId,
          creatorId: message.author.id,
          creatorName: displayName(message),
          invitees: participantSnapshot.invitees,
          participantSource: participantSnapshot.source,
          templateName: participantSnapshot.templateName,
        })
        : this.buildUpdateDraft({
          interpretation,
          meetingUrl,
          guildId: message.guildId,
          channelId: message.channelId,
          creatorId: message.author.id,
          creatorName: displayName(message),
          invitees: participantSnapshot.invitees,
          participantSource: participantSnapshot.source,
          templateName: participantSnapshot.templateName,
        });
      const preview = await message.reply({
        ...buildDraftPayload(draft),
        allowedMentions: { parse: [], repliedUser: false },
      });
      draft.previewMessageId = preview.id;
    } catch (error) {
      await replyText(`登録候補を作れませんでした: ${safeDisplayText(error.message, 200)}`);
    }
  }

  async replyPrivateAdminDetails(message, content, replyText) {
    try {
      if (typeof message?.author?.send !== "function") throw new Error("dm_unavailable");
      await message.author.send({
        content: String(content ?? "").slice(0, 1_900),
        allowedMentions: { parse: [], repliedUser: false },
      });
      await replyText("管理情報をDMに送りました。");
      return true;
    } catch {
      await replyText("管理情報をDMへ送れませんでした。DMを許可して、もう一度実行してください。内容はこのチャンネルには表示していません。");
      return false;
    }
  }

  async handleNaturalTemplateCommand(message, rawText, command, replyText) {
    try {
      if (command.action === "list") {
        const templates = this.store.attendanceTemplates.listTemplates(message.guildId);
        await this.replyPrivateAdminDetails(message, templates.length
          ? ["**参加者テンプレート**", ...templates.map((item) => `• **${safeDisplayText(item.name, 40)}** — ${item.memberCount}人${item.isDefault ? "（既定）" : ""}`)].join("\n")
          : "参加者テンプレートはまだありません。", replyText);
        return;
      }
      if (command.action === "show") {
        const template = this.store.attendanceTemplates.getTemplate(message.guildId, command.name);
        if (!template) throw new Error("参加者テンプレートが見つかりません");
        await this.replyPrivateAdminDetails(message, [
          `**${safeDisplayText(template.name, 40)}** — ${template.members.length}人${template.isDefault ? "（既定）" : ""}`,
          template.members.map((member) => safeDisplayText(member.displayName, 60)).join("、") || "メンバーなし",
        ].join("\n"), replyText);
        return;
      }
      if (command.action === "set_default") {
        const saved = this.store.attendanceTemplates.setDefaultTemplate(message.guildId, command.name);
        await replyText(`参加者テンプレート **${safeDisplayText(saved.name, 40)}** を既定にしました。今後、参加者を省略した会議作成で自動的に使います。`);
        return;
      }
      if (command.action === "remove") {
        if (!this.store.attendanceTemplates.deleteTemplate(message.guildId, command.name)) {
          throw new Error("参加者テンプレートが見つかりません");
        }
        await replyText(`参加者テンプレート **${safeDisplayText(command.name, 40)}** を削除しました。作成済み会議の招待者は変わりません。`);
        return;
      }
      if (command.action === "save") {
        const knownAliases = this.store.listMemberAliases(message.guildId).map((member) => member.alias);
        const directive = extractParticipantDirective(rawText, { knownAliases });
        const users = [...message.mentions.users.values()]
          .filter((user) => user.id !== this.client.user?.id);
        const members = this.resolveInvitees({
          guildId: message.guildId,
          aliases: directive.aliases,
          users,
        });
        if (!members.length) {
          throw new Error("保存する参加者を `参加者: メンバーA、メンバーB` またはDiscordメンションで指定してください");
        }
        const saved = this.store.attendanceTemplates.saveTemplate(message.guildId, {
          name: command.name,
          members,
          createdById: message.author.id,
          makeDefault: /既定|デフォルト|いつもの/u.test(rawText),
        });
        await replyText(`参加者テンプレート **${safeDisplayText(saved.name, 40)}** を${saved.members.length}人で保存しました${saved.isDefault ? "（既定）" : ""}。Discord IDはGPTや公開返信へ出していません。`);
      }
    } catch (error) {
      await replyText(`テンプレート操作に失敗しました: ${safeDisplayText(error.message, 220)}`);
    }
  }

  async handleNaturalManagerCommand(message, rawText, command, replyText) {
    try {
      if (command.action === "meeting_url_update") {
        await this.createNaturalUrlUpdateDraft(message, rawText, replyText);
        return;
      }
      if (command.action === "meeting_cancel") {
        const current = this.store.getMeeting(command.meetingId);
        if (!current
          || current.guildId !== message.guildId
          || current.status !== "active"
          || String(current.channelId) !== String(message.channelId)
          || !(await this.canViewMeeting(message, current))) {
          throw new Error("中止できる会議が見つかりません");
        }
        const cancelled = this.store.cancelMeeting(command.meetingId);
        if (!cancelled) throw new Error("中止できる会議が見つかりません");
        await this.refreshExistingDirectInvites(cancelled);
        await this.refreshMeetingCard(cancelled);
        this.sheetsSync?.requestSync();
        await replyText(`会議 **${cancelled.id}** を中止しました。`);
        return;
      }
      if (command.action === "member_list") {
        const members = this.store.listMemberAliases(message.guildId);
        await this.replyPrivateAdminDetails(message, members.length
          ? ["**登録済みの呼び名**", ...members.map((member) => `• **${safeDisplayText(member.alias, 32)}** → ${safeDisplayText(member.displayName, 80)}`)].join("\n")
          : "登録済みの呼び名はありません。", replyText);
        return;
      }
      if (command.action === "member_remove") {
        if (!this.store.removeMemberAlias(message.guildId, command.alias)) throw new Error("その呼び名は登録されていません");
        await replyText(`呼び名 **${safeDisplayText(command.alias, 32)}** を削除しました。過去の出欠記録は残ります。`);
        return;
      }
      if (command.action === "member_add") {
        const users = [...message.mentions.users.values()]
          .filter((user) => user.id !== this.client.user?.id);
        if (users.length !== 1) throw new Error("登録するDiscordメンバーを1人だけメンションしてください");
        const [user] = users;
        if (user.bot) throw new Error("Botはメンバー台帳へ登録できません");
        const member = message.guild?.members?.cache?.get?.(user.id) || null;
        const saved = this.store.setMemberAlias(message.guildId, {
          alias: command.alias,
          userId: user.id,
          displayName: discordUserDisplayName(user, member),
          createdById: message.author.id,
        });
        await replyText(`呼び名 **${safeDisplayText(saved.alias, 32)}** を **${safeDisplayText(saved.displayName, 80)}** に登録しました。Discord IDはGPTへ送りません。`);
        return;
      }
      if (command.action === "meeting_invite") {
        const meeting = this.store.getMeeting(command.meetingId);
        if (!meeting
          || meeting.guildId !== message.guildId
          || meeting.status !== "active"
          || String(meeting.channelId) !== String(message.channelId)
          || !(await this.canViewMeeting(message, meeting))) {
          throw new Error("招待できる会議が見つかりません");
        }
        const input = this.inviteesFromMention(message, rawText);
        const selection = this.resolveParticipantSelection({
          guildId: message.guildId,
          explicitInvitees: input.explicitInvitees,
          explicitParticipantsFound: input.explicitParticipantsFound,
          templateName: input.templateName,
          disableInvites: input.disableInvites,
          includeDefault: /いつもの|既定|デフォルト/u.test(rawText),
        });
        if (!selection.invitees.length) {
          throw new Error("招待するメンバー、参加者テンプレート、または「いつものメンバー」を指定してください");
        }
        const batch = this.store.prepareMeetingInvitees(
          meeting.id,
          selection.invitees,
          message.author.id,
          { defaultReminderMinutes: this.config.personalDefaultReminders || [] },
        );
        const result = await this.sendDirectInvites(meeting, batch.prepared);
        const parts = [`個別DM: 送信 ${result.sent}人`];
        if (result.failed) parts.push(`失敗 ${result.failed}人`);
        if (batch.alreadySent.length) parts.push(`送信済み ${batch.alreadySent.length}人`);
        await replyText([
          ...parts,
          ...(result.pending ? [`送信待ち ${result.pending}人（自動で再試行）`] : []),
        ].join(" / "));
        return;
      }
      await replyText(this.helpText());
    } catch (error) {
      await replyText(`操作できませんでした: ${safeDisplayText(error.message, 220)}`);
    }
  }

  async replyMeetingList(subject, replyText) {
    // 通常メッセージの返信は公開されるため、別チャンネルの会議を持ち出さない。
    const meetings = await this.visibleUpcomingMeetings(subject, { limit: 20, sameChannelOnly: true });
    const content = formatMeetingListContent(meetings);
    await replyText(content);
  }

  meetingStatusPayload(guildId, meetingId) {
    const id = normalizeMeetingId(meetingId);
    const meeting = this.store.getMeeting(id);
    if (!meeting || meeting.guildId !== String(guildId)) throw new Error("会議が見つかりません");
    const rsvps = this.store.listRsvps(id);
    const invitees = this.store.listMeetingInvitees(id);
    const groups = Object.keys(RSVP_LABELS).map((status) => {
      const names = rsvps.filter((rsvp) => rsvp.status === status).map((rsvp) => safeDisplayText(rsvp.displayName, 40));
      return `**${RSVP_LABELS[status]} (${names.length})**: ${names.join("、") || "なし"}`;
    });
    const answered = new Set(rsvps.map((rsvp) => rsvp.userId));
    const unanswered = invitees.filter((invitee) => !answered.has(invitee.userId));
    const failed = invitees.filter((invitee) => invitee.deliveryStatus === "failed");
    if (invitees.length) {
      groups.push(`**未回答 (${unanswered.length})**: ${unanswered.map((item) => safeDisplayText(item.displayName, 40)).join("、") || "なし"}`);
      if (failed.length) groups.push(`**DM未達 (${failed.length})**: ${failed.map((item) => safeDisplayText(item.displayName, 40)).join("、")}`);
    }
    return {
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${meeting.id} ${safeDisplayText(meeting.title, 100)}`)
        .setDescription(groups.join("\n"))],
      allowedMentions: { parse: [] },
    };
  }

  async replyMeetingStatus(subject, meetingId, replyPayload) {
    try {
      const id = normalizeMeetingId(meetingId);
      const meeting = this.store.getMeeting(id);
      if (!meeting
        || String(meeting.channelId) !== String(subject.channelId)
        || !(await this.canViewMeeting(subject, meeting))) throw new Error("会議が見つかりません");
      await replyPayload(this.meetingStatusPayload(subject.guildId, id));
    } catch (error) {
      await replyPayload({ content: safeDisplayText(error.message, 200), allowedMentions: { parse: [] } });
    }
  }

  buildCreateDraft({ title, startsAtMs, durationMinutes, reminderMinutes, meetingUrl, guildId, channelId, creatorId, creatorName, invitees = [], participantSource = "none", templateName = null, autoTitle = false }) {
    if (!title || startsAtMs == null) throw new Error("会議名と開始日時が必要です");
    const duration = durationMinutes || this.config.defaultDurationMinutes;
    return this.createDraft({
      action: "create",
      guildId: String(guildId),
      channelId: String(channelId),
      creatorId: String(creatorId),
      creatorName,
      title: safeDisplayText(title, 100),
      startsAtMs,
      endsAtMs: startsAtMs + duration * 60_000,
      reminderMinutes: normalizeMeetingReminders(reminderMinutes, this.config.defaultReminders),
      meetingUrl: String(meetingUrl ?? "").trim(),
      invitees,
      participantSource,
      templateName,
      autoTitle,
    });
  }

  buildUpdateDraft({ interpretation, meetingUrl, guildId, channelId, creatorId, creatorName, invitees = [], participantSource = "none", templateName = null }) {
    const meeting = this.store.getMeeting(interpretation.meetingId);
    if (!meeting || meeting.guildId !== String(guildId)) throw new Error("指定された会議が見つかりません");
    if (meeting.status !== "active") throw new Error("中止または終了済みの会議です");
    const fields = new Set(interpretation.providedFields);
    const startsAtMs = fields.has("startsAt") ? interpretation.startsAtMs : meeting.startsAtMs;
    const oldDuration = Math.max(5, Math.round((meeting.endsAtMs - meeting.startsAtMs) / 60_000));
    const duration = fields.has("durationMinutes") ? interpretation.durationMinutes : oldDuration;
    return this.createDraft({
      action: "update",
      meetingId: meeting.id,
      guildId: String(guildId),
      channelId: String(channelId),
      creatorId: String(creatorId),
      creatorName,
      title: fields.has("title") ? interpretation.title : meeting.title,
      startsAtMs,
      endsAtMs: startsAtMs + duration * 60_000,
      reminderMinutes: fields.has("reminderMinutes")
        ? normalizeMeetingReminders(interpretation.reminderMinutes, this.config.defaultReminders)
        : meeting.reminderMinutes,
      meetingUrl: fields.has("meetingUrl") ? meetingUrl : meeting.meetingUrl,
      invitees,
      participantSource,
      templateName,
      baseUpdatedAtMs: meeting.updatedAtMs,
      changedFields: [...fields],
      urlOnly: fields.size === 1
        && fields.has("meetingUrl")
        && invitees.length === 0
        && participantSource === "none"
        && !templateName,
    });
  }

  async handleInteraction(interaction) {
    const inConfiguredGuild = interaction.guildId === this.config.guildId;
    const inDirectMessage = interaction.guildId == null;
    if (!inConfiguredGuild && !inDirectMessage) return;
    if (interaction.isChatInputCommand() && interaction.commandName === "meeting") {
      if (!inConfiguredGuild) return;
      await this.handleCommand(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("voice:")) {
      if (!inConfiguredGuild || !this.voiceMeetingController) return;
      await this.voiceMeetingController.handleButton(interaction);
      return;
    }
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith("meeting:draft:")) {
      if (!inConfiguredGuild) return;
      const parts = interaction.customId.split(":");
      if (parts[3] === "external-url") await this.handleDraftUrlModal(interaction, parts[2]);
      return;
    }
    if (!interaction.isButton() || !interaction.customId.startsWith("meeting:")) return;
    const parts = interaction.customId.split(":");
    if (parts[1] === "draft") {
      if (!inConfiguredGuild) return;
      await this.handleDraftButton(interaction, parts[2], parts[3]);
    } else if (parts[1] === "rsvp") {
      await this.handleRsvp(interaction, parts[2], parts[3]);
    }
  }

  async handleDraftButton(interaction, draftId, action) {
    this.cleanupDrafts();
    const draft = this.drafts.get(draftId);
    if (!draft || draft.expiresAtMs <= Date.now()) {
      await interaction.update({
        content: "この確認は期限切れです。もう一度登録してください。",
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (draft.creatorId !== interaction.user.id) {
      await interaction.reply({ content: "この確認を操作できるのは登録を依頼した本人だけです。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "venue-external") {
      await interaction.showModal(buildMeetingUrlModal(draftId));
      return;
    }
    if (action === "venue-discord") {
      try {
        draft.meetingUrl = discordVoiceChannelUrl(interaction.guildId, interaction.member?.voice?.channelId);
        await interaction.update(buildDraftPayload(draft));
      } catch (error) {
        await interaction.reply({ content: safeDisplayText(error.message, 220), flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (action === "cancel") {
      this.drafts.delete(draftId);
      await interaction.update({ content: "登録を取り消しました。", embeds: [], components: [], allowedMentions: { parse: [] } });
      return;
    }
    if (action === "confirm-undecided") action = "confirm";
    if (action !== "confirm") return;
    if (String(interaction.guildId ?? "") !== draft.guildId || String(interaction.channelId ?? "") !== draft.channelId) {
      await interaction.reply({ content: "この確認は作成したサーバーとチャンネルでだけ確定できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!this.canManage(interaction)) {
      await interaction.reply({ content: "現在は会議を管理する権限がないため確定できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    this.drafts.delete(draftId);
    try {
      if (draft.action === "create") {
        await this.confirmCreate(interaction, draft);
      } else {
        await this.confirmUpdate(interaction, draft);
      }
      this.sheetsSync?.requestSync();
    } catch (error) {
      this.logger.error(`[meeting] 確定失敗 code=${shortErrorCode(error)}`);
      await interaction.editReply({
        content: `処理に失敗しました: ${safeDisplayText(error.message, 200)}`,
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  }

  async handleDraftUrlModal(interaction, draftId) {
    this.cleanupDrafts();
    const draft = this.drafts.get(draftId);
    if (!draft || draft.expiresAtMs <= Date.now()) {
      await interaction.reply({ content: "この確認は期限切れです。もう一度登録してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (draft.creatorId !== interaction.user.id) {
      await interaction.reply({ content: "この確認を操作できるのは登録を依頼した本人だけです。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (String(interaction.guildId ?? "") !== draft.guildId || String(interaction.channelId ?? "") !== draft.channelId) {
      await interaction.reply({ content: "この確認は作成したサーバーとチャンネルでだけ操作できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!this.canManage(interaction)) {
      await interaction.reply({ content: "現在は会議を管理する権限がありません。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    try {
      const rawUrl = interaction.fields.getTextInputValue("meeting_url");
      draft.meetingUrl = await this.resolveSubmittedMeetingUrl([rawUrl]);
      await interaction.editReply(buildDraftPayload(draft));
    } catch (error) {
      await interaction.followUp({
        content: `会議URLを確認できませんでした: ${safeDisplayText(error.message, 220)}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  }

  async confirmCreate(interaction, draft) {
    const channel = interaction.channel;
    const permissions = channel?.permissionsFor?.(this.client.user);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!permissions || !permissions.has(required)) {
      throw new Error("Botにチャンネル表示・送信・埋め込み権限が必要です");
    }
    if (draft.invitees?.length && !this.directMessenger?.sendMeetingInvite) {
      throw new Error("個別DM送信モジュールが初期化されていません");
    }
    let meeting = null;
    let inviteBatch = { prepared: [], alreadySent: [] };
    let saved = null;
    try {
      meeting = this.store.createMeeting({
        guildId: draft.guildId,
        channelId: draft.channelId,
        createdById: draft.creatorId,
        createdByName: draft.creatorName,
        title: draft.title,
        startsAtMs: draft.startsAtMs,
        endsAtMs: draft.endsAtMs,
        timeZone: this.config.timeZone,
        meetingUrl: draft.meetingUrl,
        reminderMinutes: draft.reminderMinutes,
        attendeeMentionOffsets: this.attendeeMentionOffsets,
        messageId: interaction.message.id,
      });
      inviteBatch = draft.invitees?.length
        ? this.store.prepareMeetingInvitees(meeting.id, draft.invitees, draft.creatorId, {
          defaultReminderMinutes: this.config.personalDefaultReminders || [],
        })
        : inviteBatch;
      saved = this.store.getMeeting(meeting.id);
      await interaction.editReply({
        content: null,
        ...buildMeetingPayload(saved, [], {
          attendeeMentionOffsets: this.attendeeMentionOffsets,
          invitees: this.store.listMeetingInvitees(meeting.id),
        }),
      });
      this.store.acknowledgePendingMeetingCardUpdate?.(saved.id, saved.cardRevision);
    } catch (error) {
      if (meeting?.id) {
        try {
          this.store.cancelMeeting(meeting.id);
        } catch (cleanupError) {
          this.logger.error(`[meeting] 作成失敗後の無効化失敗 code=${shortErrorCode(cleanupError)}`);
        }
      }
      throw error;
    }
    if (inviteBatch.prepared.length) {
      const result = await this.sendDirectInvites(saved, inviteBatch.prepared);
      await this.replyInvitationResult(interaction, result, inviteBatch.alreadySent.length);
    }
  }

  async confirmUpdate(interaction, draft) {
    const current = this.store.getMeeting(draft.meetingId);
    if (!current || current.status !== "active" || current.guildId !== draft.guildId) {
      throw new Error("更新できる会議が見つかりません");
    }
    if (!Number.isFinite(draft.baseUpdatedAtMs) || current.updatedAtMs !== draft.baseUpdatedAtMs) {
      throw new Error("確認中に会議内容が変更されました。最新の内容でもう一度入力してください");
    }
    const changedFields = new Set(draft.changedFields || (draft.urlOnly ? ["meetingUrl"] : []));
    const patch = {};
    if (changedFields.has("title")) patch.title = draft.title;
    if (changedFields.has("startsAt") || changedFields.has("durationMinutes")) {
      patch.startsAtMs = draft.startsAtMs;
      patch.endsAtMs = draft.endsAtMs;
    }
    if (changedFields.has("meetingUrl")) patch.meetingUrl = draft.meetingUrl;
    if (changedFields.has("reminderMinutes")) patch.reminderMinutes = draft.reminderMinutes;
    let meeting;
    try {
      meeting = draft.urlOnly
        ? this.store.updateMeetingUrlIfUnchanged(draft.meetingId, draft.meetingUrl, {
          expectedUpdatedAtMs: draft.baseUpdatedAtMs,
        })
        : this.store.updateMeetingIfUnchanged(draft.meetingId, patch, {
          expectedUpdatedAtMs: draft.baseUpdatedAtMs,
          attendeeMentionOffsets: this.attendeeMentionOffsets,
        });
    } catch (error) {
      if (error?.code === "meeting_update_conflict") {
        throw new Error("確認中に会議内容が変更されました。最新の内容でもう一度入力してください");
      }
      throw error;
    }
    const inviteBatch = draft.invitees?.length
      ? this.store.prepareMeetingInvitees(meeting.id, draft.invitees, draft.creatorId, {
        defaultReminderMinutes: this.config.personalDefaultReminders || [],
      })
      : { prepared: [], alreadySent: [] };
    await this.refreshExistingDirectInvites(meeting);
    await this.refreshMeetingCard(meeting);
    await interaction.editReply({
      content: `✅ **${safeDisplayText(meeting.title, 100)}** の予定を更新しました。`,
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
    if (inviteBatch.prepared.length || inviteBatch.alreadySent.length) {
      const result = await this.sendDirectInvites(meeting, inviteBatch.prepared);
      await this.replyInvitationResult(interaction, result, inviteBatch.alreadySent.length);
    }
  }

  async sendDirectInvites(meeting, invitees) {
    if (this.directInviteUpdateScheduler && this.store?.getDirectInviteSendSummary) {
      await this.directInviteUpdateScheduler.tick();
      const statuses = invitees.map((invitee) => (
        this.store.getMeetingInvitee(meeting.id, invitee.userId)?.deliveryStatus || "pending"
      ));
      const result = {
        sent: statuses.filter((status) => status === "sent").length,
        failed: statuses.filter((status) => status === "failed").length,
        pending: statuses.filter((status) => status === "pending").length,
      };
      try {
        await this.refreshMeetingCard(meeting.id);
      } catch (error) {
        this.logger.warn?.(`[dm] invite_card_refresh_failed code=${shortErrorCode(error)}`);
      }
      return result;
    }
    if (!this.directMessenger?.sendMeetingInvite) {
      throw new Error("個別DM送信モジュールが初期化されていません");
    }
    let sent = 0;
    let failed = 0;
    for (const invitee of invitees) {
      try {
        const reminder = this.store.personalReminders.getMeetingReminders(meeting.id, invitee.userId);
        const receipt = await this.directMessenger.sendMeetingInvite({
          meeting,
          recipient: {
            ...invitee,
            personalReminderMinutes: reminder?.minutes || [],
          },
        });
        this.store.markInviteeDelivery(meeting.id, invitee.userId, {
          status: "sent",
          dmMessageId: receipt.messageId,
        });
        sent += 1;
      } catch (error) {
        const code = shortErrorCode(error);
        this.store.markInviteeDelivery(meeting.id, invitee.userId, {
          status: "failed",
          errorCode: code,
        });
        failed += 1;
        this.logger.warn?.(`[dm] 招待送信失敗 code=${code}`);
      }
    }
    try {
      await this.refreshMeetingCard(meeting.id);
    } catch (error) {
      this.logger.warn?.(`[dm] 招待後カード更新失敗 code=${shortErrorCode(error)}`);
    }
    return { sent, failed };
  }

  async refreshExistingDirectInvites(meeting) {
    if (this.directInviteUpdateScheduler && this.store?.queueDirectInviteUpdates) {
      // MeetingDatabase commits the meeting mutation and this durable outbox in
      // one SQLite transaction.  Re-enqueueing here would reset lease/retry state.
      const before = this.store.getDirectInviteUpdateSummary(meeting.id, meeting.updatedAtMs);
      const queued = before.unresolved;
      if (!queued) return { queued: 0, updated: 0, failed: 0, pending: 0 };
      const tick = await this.directInviteUpdateScheduler.tick();
      const summary = this.store.getDirectInviteUpdateSummary(meeting.id, meeting.updatedAtMs);
      const result = {
        queued,
        updated: Math.max(0, queued - summary.unresolved),
        failed: summary.skipped,
        pending: summary.pending + summary.sending,
        tick,
      };
      if (result.pending || result.failed) {
        this.logger.warn?.(`[dm] invite_update_deferred pending=${result.pending} skipped=${result.failed}`);
      }
      return result;
    }
    if (!this.directMessenger?.updateMeetingInvite) return { updated: 0, failed: 0 };
    let updated = 0;
    let failed = 0;
    for (const invitee of this.store.listMeetingInvitees(meeting.id)) {
      if (invitee.deliveryStatus !== "sent" || !invitee.dmMessageId) continue;
      try {
        const reminder = this.store.personalReminders.getMeetingReminders(meeting.id, invitee.userId);
        await this.directMessenger.updateMeetingInvite({
          meeting,
          recipient: {
            ...invitee,
            personalReminderMinutes: reminder?.minutes || [],
          },
          messageId: invitee.dmMessageId,
        });
        updated += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn?.(`[dm] 既存招待更新失敗 code=${shortErrorCode(error)}`);
      }
    }
    return { updated, failed };
  }

  async replyInvitationResult(interaction, result, alreadySent = 0) {
    const parts = [`個別DM: 送信 ${result.sent}人`];
    if (result.failed) parts.push(`失敗 ${result.failed}人（相手のDM受信設定や在籍状況を確認してください）`);
    if (alreadySent) parts.push(`送信済み ${alreadySent}人`);
    try {
      await interaction.followUp({
        content: [
          ...parts,
          ...(result.pending ? [`送信待ち ${result.pending}人（自動で再試行）`] : []),
        ].join(" / "),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      this.logger.warn?.(`[dm] 送信結果表示失敗 code=${shortErrorCode(error)}`);
    }
  }

  async refreshMeetingCard(meetingOrId) {
    const suppliedMeeting = typeof meetingOrId === "string" ? null : meetingOrId;
    const meeting = typeof meetingOrId === "string" ? this.store.getMeeting(meetingOrId) : this.store.getMeeting(suppliedMeeting?.id);
    if (!meeting) return;
    if (meeting.messageId && this.meetingCardUpdateScheduler && this.store?.queueMeetingCardUpdate) {
      const queued = this.store.queueMeetingCardUpdate(meeting.id, {
        targetCardRevision: meeting.cardRevision,
      });
      const tick = await this.meetingCardUpdateScheduler.tick();
      const summary = this.store.getMeetingCardUpdateSummary(meeting.id, meeting.cardRevision);
      const result = {
        queued,
        updated: Math.max(0, queued - summary.unresolved),
        failed: summary.skipped,
        pending: summary.pending + summary.sending,
        tick,
      };
      if (result.pending || result.failed) {
        this.logger.warn?.(`[meeting-card] update_deferred pending=${result.pending} skipped=${result.failed}`);
      }
      return result;
    }
    const channel = await this.client.channels.fetch(meeting.channelId);
    if (!channel?.isTextBased?.()) throw new Error("会議カードのチャンネルが見つかりません");
    const payload = buildMeetingPayload(meeting, this.store.listRsvps(meeting.id), {
      attendeeMentionOffsets: this.attendeeMentionOffsets,
      invitees: this.store.listMeetingInvitees(meeting.id),
    });
    if (meeting.messageId) {
      try {
        const message = await channel.messages.fetch(meeting.messageId);
        await message.edit(payload);
        return;
      } catch (error) {
        if (Number(error?.code) !== 10008) throw error;
      }
    }
    const message = await channel.send(payload);
    this.store.setMessageId(meeting.id, message.id);
  }

  async handleRsvp(interaction, meetingId, status) {
    if (!Object.hasOwn(RSVP_LABELS, status)) return;
    const inDirectMessage = interaction.guildId == null;
    await interaction.deferReply(inDirectMessage ? {} : { flags: MessageFlags.Ephemeral });
    try {
      const meeting = this.store.getMeeting(meetingId);
      if (!meeting || meeting.guildId !== this.config.guildId) throw new Error("会議が見つかりません");
      if (inDirectMessage) {
        if (!this.directMessenger?.currentHumanMember) {
          throw new Error("DMからの本人確認を実行できません");
        }
        await this.directMessenger.currentHumanMember(interaction.user.id);
      }
      const invitees = this.store.listMeetingInvitees(meeting.id);
      if (invitees.length && !this.store.isMeetingInvitee(meeting.id, interaction.user.id)) {
        throw new Error(inDirectMessage
          ? "このDMから回答できる招待が見つかりません"
          : "この会議は招待されたメンバーだけが回答できます");
      }
      this.store.upsertRsvp(meeting.id, {
        userId: interaction.user.id,
        displayName: inDirectMessage
          ? (this.store.getMemberAliasByUserId(this.config.guildId, interaction.user.id)?.displayName || displayName(interaction))
          : displayName(interaction),
        status,
      });
      if (status !== "declined") {
        const personal = this.store.personalReminders.getMeetingReminders(meeting.id, interaction.user.id);
        if (personal) {
          this.store.personalReminders.replaceMeetingReminders({
            meetingId: meeting.id,
            userId: interaction.user.id,
            startsAtMs: meeting.startsAtMs,
            minutes: personal.minutes,
            source: personal.source,
          });
        }
      }
      await this.refreshMeetingCard(meeting.id);
      this.sheetsSync?.requestSync();
      if (inDirectMessage) {
        const personal = this.store.personalReminders.getMeetingReminders(meeting.id, interaction.user.id);
        await interaction.editReply(buildDirectConfirmationPayload(meeting, {
          statusLabel: RSVP_LABELS[status],
          personalReminderMinutes: personal?.minutes || [],
        }));
      } else {
        await interaction.editReply({
          content: `確認しました。出欠を「${RSVP_LABELS[status]}」に更新しました。会議URLはこの確認返信へ再掲しません。`,
          allowedMentions: { parse: [] },
        });
      }
    } catch (error) {
      await interaction.editReply({ content: `出欠を更新できませんでした: ${safeDisplayText(error.message, 180)}` });
    }
  }

  async handleDirectMessage(message) {
    if (this.directMessenger?.currentHumanMember) {
      try {
        await this.directMessenger.currentHumanMember(message.author.id);
      } catch {
        await message.reply({
          content: "このサーバーに在籍している本人だけがDMから設定できます。",
          allowedMentions: { parse: [] },
        });
        return;
      }
    }
    const handled = await this.selfService.handleMessage(message, { privateReply: true });
    if (handled) return;
    const invitations = this.store.listOpenInvitationsForUser(message.author.id);
    await message.reply({
      content: invitations.length
        ? [
          "「参加します」「未定です」「欠席します」のように返信してください。",
          "通知時刻は「1時間前と10分前に通知して」「今後は通知なし」のように指定できます。",
          invitations.length > 1 ? "会議が複数ある場合は `会議ID 参加` の形で書いてください。" : `対象会議: **${invitations[0].id}** ${safeDisplayText(invitations[0].title, 80)}`,
        ].join("\n")
        : "現在、回答できる招待はありません。今後の通知設定は「今後は1時間前と10分前に通知して」のように変更できます。",
      allowedMentions: { parse: [] },
    });
  }

  async handleCommand(interaction) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "voice-privacy") {
      await interaction.reply({
        content: this.voiceMeetingController?.privacyText() || "VC文字起こし機能はまだ設定されていません。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (subcommand === "voice-status") {
      await interaction.reply({
        content: this.voiceMeetingController?.statusText(interaction) || "VC文字起こし機能はまだ設定されていません。",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (subcommand === "voice-stop") {
      await this.commandVoiceStop(interaction);
      return;
    }
    if (subcommand === "help") {
      await interaction.reply({ content: this.helpText(), flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === "list") {
      await this.commandList(interaction);
      return;
    }
    if (subcommand === "status") {
      await this.commandStatus(interaction);
      return;
    }
    if (subcommand === "my-reminders") {
      await this.commandMyReminders(interaction);
      return;
    }
    const managerReply = async (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (!(await this.requireManager(interaction, managerReply))) return;
    if (subcommand === "create") await this.commandCreate(interaction);
    else if (subcommand === "url") await this.commandUrl(interaction);
    else if (subcommand === "cancel") await this.commandCancel(interaction);
    else if (subcommand === "member-add") await this.commandMemberAdd(interaction);
    else if (subcommand === "member-list") await this.commandMemberList(interaction);
    else if (subcommand === "member-remove") await this.commandMemberRemove(interaction);
    else if (subcommand === "template-save") await this.commandTemplateSave(interaction);
    else if (subcommand === "template-list") await this.commandTemplateList(interaction);
    else if (subcommand === "template-show") await this.commandTemplateShow(interaction);
    else if (subcommand === "template-default") await this.commandTemplateDefault(interaction);
    else if (subcommand === "template-remove") await this.commandTemplateRemove(interaction);
    else if (subcommand === "invite") await this.commandInvite(interaction);
    else if (subcommand === "voice-start") await this.commandVoiceStart(interaction);
    else if (subcommand === "voice-reprocess") await this.commandVoiceReprocess(interaction);
    else if (subcommand === "voice-delete") await this.commandVoiceDelete(interaction);
  }

  async commandVoiceStart(interaction) {
    if (!this.voiceMeetingController) {
      await interaction.reply({ content: "VC文字起こし機能はまだ設定されていません。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await this.voiceMeetingController.requestStart(interaction, {
        title: interaction.options.getString("title") || "VCミーティング",
      });
      await interaction.editReply({
        content: `専用チャンネルで参加者全員の同意を確認します。セッション: ${result.sessionId}`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      const content = safeDisplayText(error.message, 240);
      if (interaction.deferred) await interaction.editReply({ content, allowedMentions: { parse: [] } });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  }

  async commandVoiceStop(interaction) {
    if (!this.voiceMeetingController) {
      await interaction.reply({ content: "VC文字起こし機能はまだ設定されていません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const userId = String(interaction.user.id);
    const isParticipant = this.voiceMeetingController.session?.requiredUserIds?.has?.(userId);
    if (!this.canManage(interaction) && !isParticipant) {
      await interaction.reply({ content: "現在のVC参加者または会議管理者だけが停止できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await this.voiceMeetingController.stopSession({ reason: "manual", requestedById: userId });
      await interaction.editReply({
        content: result.stopped ? `停止しました。セッション ${result.sessionId} の議事録を処理しています。` : "動作中のVC文字起こしはありません。",
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.editReply({ content: safeDisplayText(error.message, 240), allowedMentions: { parse: [] } });
    }
  }

  async commandVoiceReprocess(interaction) {
    if (!this.voiceMeetingController) {
      await interaction.reply({ content: "VC文字起こし機能はまだ設定されていません。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const id = interaction.options.getString("session_id", true).trim().toUpperCase();
      const result = await this.voiceMeetingController.reprocess(id);
      await interaction.reply({ content: `セッション ${result.sessionId} の再処理を開始しました。`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 240), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  }

  async commandVoiceDelete(interaction) {
    if (!this.voiceMeetingController) {
      await interaction.reply({ content: "VC文字起こし機能はまだ設定されていません。", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const id = interaction.options.getString("session_id", true).trim().toUpperCase();
      await this.voiceMeetingController.deleteSession(id);
      await interaction.reply({ content: `セッション ${id} のローカルバックアップを削除しました。`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 240), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
  }

  async commandCreate(interaction) {
    const rawUrl = interaction.options.getString("url")?.trim() || null;
    const voiceChannel = interaction.options.getChannel("voice_channel");
    if (rawUrl && voiceChannel) {
      await interaction.reply({ content: "会議URLとDiscord VCはどちらか一方だけ選んでください。", flags: MessageFlags.Ephemeral });
      return;
    }
    let resolvingInvitation = false;
    try {
      if (!rawUrl) throw new Error("url_not_set");
      resolvingInvitation = isCalendarInvitationUrl(normalizeMeetingUrl(rawUrl));
    } catch {
      // 入力エラーは下の共通エラー返信で案内する。
    }
    if (resolvingInvitation) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const start = parseJstDateTime(interaction.options.getString("start", true));
      if (start < Date.now() - 5 * 60_000) throw new Error("開始日時は現在より後にしてください");
      const duration = interaction.options.getInteger("duration") || this.config.defaultDurationMinutes;
      const remindersRaw = interaction.options.getString("reminders");
      const reminders = remindersRaw
        ? normalizeReminderMinutes(remindersRaw.split(",").map((value) => Number.parseInt(value.trim(), 10)), this.config.defaultReminders)
        : this.config.defaultReminders;
      const participants = this.participantSelectionFromOptions(interaction, {
        includeDefault: true,
        allowNoDm: true,
      });
      const draft = this.buildCreateDraft({
        title: interaction.options.getString("title", true),
        startsAtMs: start,
        durationMinutes: duration,
        reminderMinutes: reminders,
        meetingUrl: voiceChannel
          ? discordVoiceChannelUrl(interaction.guildId, voiceChannel.id)
          : rawUrl ? await this.resolveSubmittedMeetingUrl([rawUrl]) : "",
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        creatorId: interaction.user.id,
        creatorName: displayName(interaction),
        invitees: participants.invitees,
        participantSource: participants.source,
        templateName: participants.templateName,
      });
      if (resolvingInvitation) {
        await interaction.editReply({ content: "招待URLから会議URLを確認しました。確認画面をチャンネルへ表示します。" });
        await interaction.followUp(buildDraftPayload(draft));
      } else {
        await interaction.reply(buildDraftPayload(draft));
      }
    } catch (error) {
      const payload = { content: safeDisplayText(error.message, 240), flags: MessageFlags.Ephemeral };
      if (resolvingInvitation) await interaction.editReply({ content: payload.content });
      else await interaction.reply(payload);
    }
  }

  async commandUrl(interaction) {
    const rawUrl = interaction.options.getString("url", true);
    let resolvingInvitation = false;
    try {
      resolvingInvitation = isCalendarInvitationUrl(normalizeMeetingUrl(rawUrl));
    } catch {
      // 入力エラーは下の共通エラー返信で案内する。
    }
    if (resolvingInvitation) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const id = normalizeMeetingId(interaction.options.getString("id", true));
      const meeting = this.store.getMeeting(id);
      if (!meeting || meeting.guildId !== interaction.guildId || !(await this.canViewMeeting(interaction, meeting))) {
        throw new Error("会議が見つかりません");
      }
      const draft = this.createDraft({
        action: "update",
        meetingId: meeting.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        creatorId: interaction.user.id,
        creatorName: displayName(interaction),
        title: meeting.title,
        startsAtMs: meeting.startsAtMs,
        endsAtMs: meeting.endsAtMs,
        reminderMinutes: meeting.reminderMinutes,
        meetingUrl: await this.resolveSubmittedMeetingUrl([rawUrl]),
        urlOnly: true,
        baseUpdatedAtMs: meeting.updatedAtMs,
        changedFields: ["meetingUrl"],
      });
      if (resolvingInvitation) {
        await interaction.editReply({ content: "招待URLから会議URLを確認しました。確認画面をチャンネルへ表示します。" });
        await interaction.followUp({ ...buildDraftPayload(draft), flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ ...buildDraftPayload(draft), flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      const payload = { content: safeDisplayText(error.message, 240), flags: MessageFlags.Ephemeral };
      if (resolvingInvitation) await interaction.editReply({ content: payload.content });
      else await interaction.reply(payload);
    }
  }

  async commandMemberAdd(interaction) {
    try {
      const user = interaction.options.getUser("user", true);
      if (user.bot) throw new Error("Botはメンバー台帳へ登録できません");
      const member = interaction.options.getMember("user");
      const saved = this.store.setMemberAlias(interaction.guildId, {
        alias: interaction.options.getString("alias", true),
        userId: user.id,
        displayName: discordUserDisplayName(user, member),
        createdById: interaction.user.id,
      });
      await interaction.reply({
        content: `呼び名 **${safeDisplayText(saved.alias, 32)}** を **${safeDisplayText(saved.displayName, 80)}** に登録しました。Discord IDはGPTやスプレッドシートへ送りません。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 220), flags: MessageFlags.Ephemeral });
    }
  }

  async commandMemberList(interaction) {
    const members = this.store.listMemberAliases(interaction.guildId);
    const content = members.length
      ? ["**登録済みの呼び名（管理者だけに表示）**", ...members.map((member) => `• **${safeDisplayText(member.alias, 32)}** → ${safeDisplayText(member.displayName, 80)}`)].join("\n")
      : "登録済みの呼び名はありません。`/meeting member-add` から登録できます。";
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  async commandMemberRemove(interaction) {
    try {
      const alias = interaction.options.getString("alias", true);
      if (!this.store.removeMemberAlias(interaction.guildId, alias)) throw new Error("その呼び名は登録されていません");
      await interaction.reply({
        content: `呼び名 **${safeDisplayText(alias, 32)}** を削除しました。過去の出欠記録は削除されません。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 220), flags: MessageFlags.Ephemeral });
    }
  }

  async commandTemplateSave(interaction) {
    try {
      const participants = this.participantSelectionFromOptions(interaction);
      if (!participants.invitees.length) {
        throw new Error("保存するメンバー、呼び名、またはコピー元テンプレートを指定してください");
      }
      const saved = this.store.attendanceTemplates.saveTemplate(interaction.guildId, {
        name: interaction.options.getString("name", true),
        members: participants.invitees,
        createdById: interaction.user.id,
        makeDefault: Boolean(interaction.options.getBoolean("default")),
      });
      await interaction.reply({
        content: `参加者テンプレート **${safeDisplayText(saved.name, 40)}** を${saved.members.length}人で保存しました${saved.isDefault ? "（既定）" : ""}。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 220), flags: MessageFlags.Ephemeral });
    }
  }

  async commandTemplateList(interaction) {
    const templates = this.store.attendanceTemplates.listTemplates(interaction.guildId);
    const content = templates.length
      ? ["**参加者テンプレート**", ...templates.map((item) => `• **${safeDisplayText(item.name, 40)}** — ${item.memberCount}人${item.isDefault ? "（既定）" : ""}`)].join("\n")
      : "参加者テンプレートはまだありません。";
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  async commandTemplateShow(interaction) {
    try {
      const template = this.store.attendanceTemplates.getTemplate(
        interaction.guildId,
        interaction.options.getString("name", true),
      );
      if (!template) throw new Error("参加者テンプレートが見つかりません");
      await interaction.reply({
        content: [
          `**${safeDisplayText(template.name, 40)}** — ${template.members.length}人${template.isDefault ? "（既定）" : ""}`,
          template.members.map((member) => safeDisplayText(member.displayName, 60)).join("、") || "メンバーなし",
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 220), flags: MessageFlags.Ephemeral });
    }
  }

  async commandTemplateDefault(interaction) {
    try {
      const saved = this.store.attendanceTemplates.setDefaultTemplate(
        interaction.guildId,
        interaction.options.getString("name", true),
      );
      await interaction.reply({
        content: `参加者テンプレート **${safeDisplayText(saved.name, 40)}** を既定にしました。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 220), flags: MessageFlags.Ephemeral });
    }
  }

  async commandTemplateRemove(interaction) {
    try {
      const name = interaction.options.getString("name", true);
      if (!this.store.attendanceTemplates.deleteTemplate(interaction.guildId, name)) {
        throw new Error("参加者テンプレートが見つかりません");
      }
      await interaction.reply({
        content: `参加者テンプレート **${safeDisplayText(name, 40)}** を削除しました。作成済み会議は変わりません。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 220), flags: MessageFlags.Ephemeral });
    }
  }

  async commandMyReminders(interaction) {
    try {
      const when = interaction.options.getString("when");
      if (!when) {
        const preference = this.store.personalReminders.getMemberPreference(interaction.guildId, interaction.user.id);
        await interaction.reply({
          content: preference
            ? `あなたの今後の個別通知は **${formatPersonalReminderMinutes(preference.minutes)}** です。`
            : `個人通知は未設定です。新しい招待ではサーバー初期値の **${formatPersonalReminderMinutes(this.config.personalDefaultReminders || [])}** を使います。`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }
      const parsed = parsePersonalReminderRequest(when);
      if (!parsed || parsed.needsClarification) {
        throw new Error("通知時刻を確認できません。例: `1時間前と10分前` / `通知なし`");
      }
      const saved = this.store.personalReminders.setMemberPreference(
        interaction.guildId,
        interaction.user.id,
        parsed.minutes,
      );
      await interaction.reply({
        content: `確認しました。今後の個別通知を **${formatPersonalReminderMinutes(saved.minutes)}** にしました。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 220), flags: MessageFlags.Ephemeral });
    }
  }

  async commandInvite(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const id = normalizeMeetingId(interaction.options.getString("id", true));
      const meeting = this.store.getMeeting(id);
      if (!meeting
        || meeting.guildId !== interaction.guildId
        || meeting.status !== "active"
        || !(await this.canViewMeeting(interaction, meeting))) {
        throw new Error("招待できる会議が見つかりません");
      }
      const participants = this.participantSelectionFromOptions(interaction);
      if (!participants.invitees.length) throw new Error("DMを送るメンバー、登録済みの呼び名、または参加者テンプレートを1つ以上指定してください");
      const batch = this.store.prepareMeetingInvitees(
        meeting.id,
        participants.invitees,
        interaction.user.id,
        { defaultReminderMinutes: this.config.personalDefaultReminders || [] },
      );
      const result = batch.prepared.length
        ? await this.sendDirectInvites(meeting, batch.prepared)
        : { sent: 0, failed: 0 };
      const parts = [`個別DM: 送信 ${result.sent}人`];
      if (result.failed) parts.push(`失敗 ${result.failed}人（相手のDM受信設定や在籍状況を確認してください）`);
      if (batch.alreadySent.length) parts.push(`すでに送信済み ${batch.alreadySent.length}人`);
      await interaction.editReply({ content: parts.join(" / "), allowedMentions: { parse: [] } });
    } catch (error) {
      await interaction.editReply({ content: safeDisplayText(error.message, 240), allowedMentions: { parse: [] } });
    }
  }

  async commandList(interaction) {
    const meetings = await this.visibleUpcomingMeetings(interaction, { limit: 20 });
    const content = formatMeetingListContent(meetings);
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  async commandStatus(interaction) {
    try {
      const id = normalizeMeetingId(interaction.options.getString("id", true));
      const meeting = this.store.getMeeting(id);
      if (!meeting || !(await this.canViewMeeting(interaction, meeting))) throw new Error("会議が見つかりません");
      const rsvps = this.store.listRsvps(id);
      const invitees = this.store.listMeetingInvitees(id);
      const groups = Object.keys(RSVP_LABELS).map((status) => {
        const names = rsvps.filter((rsvp) => rsvp.status === status).map((rsvp) => safeDisplayText(rsvp.displayName, 40));
        return `**${RSVP_LABELS[status]} (${names.length})**: ${names.join("、") || "なし"}`;
      });
      const answered = new Set(rsvps.map((rsvp) => rsvp.userId));
      const unanswered = invitees.filter((invitee) => !answered.has(invitee.userId));
      const failed = invitees.filter((invitee) => invitee.deliveryStatus === "failed");
      if (invitees.length) {
        groups.push(`**未回答 (${unanswered.length})**: ${unanswered.map((item) => safeDisplayText(item.displayName, 40)).join("、") || "なし"}`);
        if (failed.length) groups.push(`**DM未達 (${failed.length})**: ${failed.map((item) => safeDisplayText(item.displayName, 40)).join("、")}`);
      }
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`${meeting.id} ${meeting.title}`)
          .setDescription(groups.join("\n"))],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 200), flags: MessageFlags.Ephemeral });
    }
  }

  async commandCancel(interaction) {
    try {
      const id = normalizeMeetingId(interaction.options.getString("id", true));
      const meeting = this.store.getMeeting(id);
      if (!meeting || meeting.guildId !== interaction.guildId || !(await this.canViewMeeting(interaction, meeting))) {
        throw new Error("会議が見つかりません");
      }
      const cancelled = this.store.cancelMeeting(id);
      if (!cancelled) throw new Error("会議はすでに中止または終了しています");
      await this.refreshExistingDirectInvites(cancelled);
      await this.refreshMeetingCard(cancelled);
      this.sheetsSync?.requestSync();
      await interaction.reply({ content: `会議 **${id}** を中止しました。`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 200), flags: MessageFlags.Ephemeral });
    }
  }

  helpText() {
    const mention = this.client.user ? `<@${this.client.user.id}>` : "@Bot";
    return [
      "**会議Botのかんたん使い方**",
      "1. 初回だけ: `/meeting member-add` または通常チャンネルでBotをメンションし、Discordメンバーへ「メンバーA」などの呼び名を登録します。",
      `2. 固定メンバー: ${mention} テンプレート「全体定例」として参加者: メンバーA、メンバーB を保存`,
      `3. 会議登録: ${mention} 来週月曜20:30から全体定例、URL未定（URLは省略できます）`,
      "4. 黄色い確認画面で「今いるDiscord VC」「Google Meet / 外部URL」「未定で登録」から開催方法を選びます。",
      `5. URLを後から足す: 同じ会議名・日時とURLをまとめて送るか、会議カードへ ${mention} とURLを付けて返信します。`,
      "6. 招待された人はボタンまたはDMで「参加します」「未定です」「欠席します」「1時間前と10分前に通知して」と返信できます。",
      "`/meeting` の全操作は、通常チャンネルでBotをメンションして自然な日本語でも実行できます。",
      "例: `会議一覧を見せて` / `全体定例のリンクはこれ URL` / `MEET0001の出欠状況` / `自分の通知設定を見せて`",
      "※会議URL・Discord ID・登録した呼び名・テンプレート名・DM本文/回答はGPTへ送りません。本人操作はローカルで処理します。",
    ].join("\n");
  }

  templateHelpText() {
    const mention = this.client.user ? `<@${this.client.user.id}>` : "@Bot";
    return [
      "**参加者テンプレートの作り方**",
      "1. 最初に、各Discordメンバーへ「メンバーA」などの呼び名を登録します。",
      `例: \`${mention} @対象メンバー を メンバーA として登録して\``,
      "2. 呼び名を並べて、好きなテンプレート名で保存します。",
      `例: \`${mention} テンプレート「全体定例」として 参加者: メンバーA、メンバーB を保存\``,
      "3. 毎回そのメンバーを使うなら既定にします。",
      `例: \`${mention} テンプレート「全体定例」を既定にして\``,
      `確認: \`${mention} テンプレート一覧を見せて\``,
      "※呼び名とDiscord IDの対応はローカルだけに保存し、AIへ送りません。",
    ].join("\n");
  }
}
