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
import { buildDirectConfirmationPayload, buildDraftPayload, buildMeetingPayload } from "./discord-ui.mjs";
import { parseGuildNaturalCommand } from "./local-command-router.mjs";
import { resolveParticipantSnapshot } from "./participant-resolution.mjs";
import {
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
  meetingUrl: "会議URL",
  meetingId: "会議ID",
  requestedChanges: "変更内容",
};
const RSVP_LABELS = { attending: "参加", maybe: "未定", declined: "欠席" };
const MAX_MEETING_INVITEES = 20;

function shortErrorCode(error) {
  return String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
}

function normalizeMeetingId(value) {
  const id = String(value ?? "").trim().toUpperCase().replace(/^#/, "");
  if (!/^[A-Z0-9]{8}$/u.test(id)) throw new Error("会議IDは8文字で指定してください");
  return id;
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
  constructor({ client, store, interpreter, sheetsSync, config, directMessenger = null, logger = console }) {
    this.client = client;
    this.store = store;
    this.interpreter = interpreter;
    this.sheetsSync = sheetsSync;
    this.config = config;
    this.directMessenger = directMessenger;
    this.logger = logger;
    this.drafts = new Map();
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
    const templateReference = extractTemplateReference(rawText);
    const directive = extractParticipantDirective(templateReference.cleanedText);
    const registered = this.store.listMemberAliases(message.guildId);
    const users = [...message.mentions.users.values()]
      .filter((user) => user.id !== this.client.user?.id);
    return {
      cleanedText: directive.cleanedText,
      knownAliases: registered.map((member) => member.alias),
      explicitInvitees: this.resolveInvitees({ guildId: message.guildId, aliases: directive.aliases, users }),
      explicitParticipantsFound: Boolean(directive.found || users.length),
      templateName: templateReference.templateName,
      disableInvites: directive.disableInvites,
    };
  }

  async handleMention(message, rawText) {
    const replyText = async (content) => message.reply({
      content,
      allowedMentions: { parse: [], repliedUser: false },
    });

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

    const localCommand = parseGuildNaturalCommand(rawText);
    if (localCommand?.action === "help") {
      await replyText(this.helpText());
      return;
    }
    if (localCommand?.action === "meeting_list") {
      await this.replyMeetingList(message.guildId, replyText);
      return;
    }
    if (localCommand?.action === "meeting_status") {
      await this.replyMeetingStatus(message.guildId, localCommand.meetingId, message.reply.bind(message));
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
      await replyText("自然言語での会議作成・更新には `OPENAI_API_KEY` が必要です。設定までは `/meeting create` で登録できます。テンプレートや出欠はAIなしで利用できます。");
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
      assertSafeForAi(extracted.sanitizedText);
    } catch {
      await replyText("URLを安全に分離できなかったため処理を止めました。URLと会議内容を分けてもう一度送ってください。");
      return;
    }
    if (extracted.urls.length > 1) {
      await replyText("会議URLが複数あります。誤登録を防ぐため、登録するURLを1つだけにしてもう一度送ってください。");
      return;
    }
    if (!extracted.sanitizedText) {
      await replyText(this.helpText());
      return;
    }

    let interpretation;
    try {
      interpretation = await this.interpreter.interpret({
        sanitizedText: extracted.sanitizedText,
        hasMeetingUrl: extracted.urls.length === 1,
      });
    } catch (error) {
      this.logger.error(`[openai] 会議入力の整形に失敗 code=${shortErrorCode(error)}`);
      await replyText("会議内容のAI整形に失敗しました。URLはAIへ送信されていません。少し待つか `/meeting create` を使ってください。");
      return;
    }

    if (interpretation.action === "unknown") {
      await replyText(interpretation.clarification || `会議登録として解釈できませんでした。\n例: ${this.client.user} 来週月曜20:30から定例会議、URLは…`);
      return;
    }
    if (interpretation.missingFields.length) {
      const fields = interpretation.missingFields.map((field) => MISSING_LABELS[field] || field).join("、");
      await replyText(`${interpretation.clarification ? `${interpretation.clarification}\n` : ""}不足項目: **${fields}**\n日時・会議名・URLを含めてもう一度送ってください。`);
      return;
    }

    try {
      const meetingUrl = extracted.urls[0] ? normalizeMeetingUrl(extracted.urls[0]) : null;
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

  async handleNaturalTemplateCommand(message, rawText, command, replyText) {
    try {
      if (command.action === "list") {
        const templates = this.store.attendanceTemplates.listTemplates(message.guildId);
        await replyText(templates.length
          ? ["**参加者テンプレート**", ...templates.map((item) => `• **${safeDisplayText(item.name, 40)}** — ${item.memberCount}人${item.isDefault ? "（既定）" : ""}`)].join("\n")
          : "参加者テンプレートはまだありません。");
        return;
      }
      if (command.action === "show") {
        const template = this.store.attendanceTemplates.getTemplate(message.guildId, command.name);
        if (!template) throw new Error("参加者テンプレートが見つかりません");
        await replyText([
          `**${safeDisplayText(template.name, 40)}** — ${template.members.length}人${template.isDefault ? "（既定）" : ""}`,
          template.members.map((member) => safeDisplayText(member.displayName, 60)).join("、") || "メンバーなし",
        ].join("\n"));
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
        const directive = extractParticipantDirective(rawText);
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
      if (command.action === "meeting_cancel") {
        const current = this.store.getMeeting(command.meetingId);
        if (!current || current.guildId !== message.guildId || current.status !== "active") {
          throw new Error("中止できる会議が見つかりません");
        }
        const cancelled = this.store.cancelMeeting(command.meetingId);
        if (!cancelled) throw new Error("中止できる会議が見つかりません");
        await this.refreshMeetingCard(cancelled);
        this.sheetsSync?.requestSync();
        await replyText(`会議 **${cancelled.id}** を中止しました。`);
        return;
      }
      if (command.action === "member_list") {
        const members = this.store.listMemberAliases(message.guildId);
        await replyText(members.length
          ? ["**登録済みの呼び名**", ...members.map((member) => `• **${safeDisplayText(member.alias, 32)}** → ${safeDisplayText(member.displayName, 80)}`)].join("\n")
          : "登録済みの呼び名はありません。");
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
        if (!meeting || meeting.guildId !== message.guildId || meeting.status !== "active") {
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
        await replyText(parts.join(" / "));
        return;
      }
      await replyText(this.helpText());
    } catch (error) {
      await replyText(`操作できませんでした: ${safeDisplayText(error.message, 220)}`);
    }
  }

  async replyMeetingList(guildId, replyText) {
    const meetings = this.store.listUpcoming(guildId, { limit: 20 });
    const content = meetings.length
      ? meetings.map((meeting) => `• **${meeting.id}** ${safeDisplayText(meeting.title, 80)} — ${discordTimestamp(meeting.startsAtMs, "F")}`).join("\n")
      : "開催予定の会議はありません。";
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

  async replyMeetingStatus(guildId, meetingId, replyPayload) {
    try {
      await replyPayload(this.meetingStatusPayload(guildId, meetingId));
    } catch (error) {
      await replyPayload({ content: safeDisplayText(error.message, 200), allowedMentions: { parse: [] } });
    }
  }

  buildCreateDraft({ title, startsAtMs, durationMinutes, reminderMinutes, meetingUrl, guildId, channelId, creatorId, creatorName, invitees = [], participantSource = "none", templateName = null }) {
    if (!title || startsAtMs == null || !meetingUrl) throw new Error("会議名・開始日時・URLが必要です");
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
      reminderMinutes: normalizeReminderMinutes(reminderMinutes, this.config.defaultReminders),
      meetingUrl,
      invitees,
      participantSource,
      templateName,
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
      reminderMinutes: fields.has("reminderMinutes") ? interpretation.reminderMinutes : meeting.reminderMinutes,
      meetingUrl: fields.has("meetingUrl") ? meetingUrl : meeting.meetingUrl,
      invitees,
      participantSource,
      templateName,
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
      await interaction.reply({ content: "この確認は期限切れです。もう一度登録してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (draft.creatorId !== interaction.user.id) {
      await interaction.reply({ content: "この確認を操作できるのは登録を依頼した本人だけです。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "cancel") {
      this.drafts.delete(draftId);
      await interaction.update({ content: "登録を取り消しました。", embeds: [], components: [], allowedMentions: { parse: [] } });
      return;
    }
    if (action !== "confirm") return;
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

  async confirmCreate(interaction, draft) {
    const channel = interaction.channel;
    const permissions = channel?.permissionsFor?.(this.client.user);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!permissions || !permissions.has(required)) {
      throw new Error("Botにチャンネル表示・送信・埋め込み権限が必要です");
    }
    if (this.config.everyoneOffsets.length && !permissions.has(PermissionFlagsBits.MentionEveryone)) {
      throw new Error("自動通知にはBotの「@everyone、@here、すべてのロールにメンション」権限が必要です");
    }
    const meeting = this.store.createMeeting({
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
      everyoneOffsets: this.config.everyoneOffsets,
    });
    const inviteBatch = draft.invitees?.length
      ? this.store.prepareMeetingInvitees(meeting.id, draft.invitees, draft.creatorId, {
        defaultReminderMinutes: this.config.personalDefaultReminders || [],
      })
      : { prepared: [], alreadySent: [] };
    this.store.setMessageId(meeting.id, interaction.message.id);
    const saved = this.store.getMeeting(meeting.id);
    await interaction.editReply({
      content: null,
      ...buildMeetingPayload(saved, [], {
        everyoneOffsets: this.config.everyoneOffsets,
        invitees: this.store.listMeetingInvitees(meeting.id),
      }),
    });
    if (inviteBatch.prepared.length) {
      const result = await this.sendDirectInvites(saved, inviteBatch.prepared);
      await this.replyInvitationResult(interaction, result, inviteBatch.alreadySent.length);
    }
  }

  async confirmUpdate(interaction, draft) {
    const meeting = this.store.updateMeeting(draft.meetingId, {
      title: draft.title,
      startsAtMs: draft.startsAtMs,
      endsAtMs: draft.endsAtMs,
      meetingUrl: draft.meetingUrl,
      reminderMinutes: draft.reminderMinutes,
    }, { everyoneOffsets: this.config.everyoneOffsets });
    const inviteBatch = draft.invitees?.length
      ? this.store.prepareMeetingInvitees(meeting.id, draft.invitees, draft.creatorId, {
        defaultReminderMinutes: this.config.personalDefaultReminders || [],
      })
      : { prepared: [], alreadySent: [] };
    await this.refreshMeetingCard(meeting);
    await interaction.editReply({
      content: `✅ 会議 **${meeting.id}** を更新しました。`,
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

  async replyInvitationResult(interaction, result, alreadySent = 0) {
    const parts = [`個別DM: 送信 ${result.sent}人`];
    if (result.failed) parts.push(`失敗 ${result.failed}人（相手のDM受信設定や在籍状況を確認してください）`);
    if (alreadySent) parts.push(`送信済み ${alreadySent}人`);
    try {
      await interaction.followUp({
        content: parts.join(" / "),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      this.logger.warn?.(`[dm] 送信結果表示失敗 code=${shortErrorCode(error)}`);
    }
  }

  async refreshMeetingCard(meetingOrId) {
    const meeting = typeof meetingOrId === "string" ? this.store.getMeeting(meetingOrId) : meetingOrId;
    if (!meeting) return;
    const channel = await this.client.channels.fetch(meeting.channelId);
    if (!channel?.isTextBased?.()) throw new Error("会議カードのチャンネルが見つかりません");
    const payload = buildMeetingPayload(meeting, this.store.listRsvps(meeting.id), {
      everyoneOffsets: this.config.everyoneOffsets,
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
      if (inDirectMessage && !this.store.isMeetingInvitee(meeting.id, interaction.user.id)) {
        throw new Error("このDMから回答できる招待が見つかりません");
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
  }

  async commandCreate(interaction) {
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
        meetingUrl: normalizeMeetingUrl(interaction.options.getString("url", true)),
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        creatorId: interaction.user.id,
        creatorName: displayName(interaction),
        invitees: participants.invitees,
        participantSource: participants.source,
        templateName: participants.templateName,
      });
      await interaction.reply(buildDraftPayload(draft));
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 240), flags: MessageFlags.Ephemeral });
    }
  }

  async commandUrl(interaction) {
    try {
      const id = normalizeMeetingId(interaction.options.getString("id", true));
      const meeting = this.store.getMeeting(id);
      if (!meeting || meeting.guildId !== interaction.guildId) throw new Error("会議が見つかりません");
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
        meetingUrl: normalizeMeetingUrl(interaction.options.getString("url", true)),
      });
      await interaction.reply(buildDraftPayload(draft));
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 240), flags: MessageFlags.Ephemeral });
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
      if (!meeting || meeting.guildId !== interaction.guildId || meeting.status !== "active") {
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
    const meetings = this.store.listUpcoming(interaction.guildId, { limit: 20 });
    const content = meetings.length
      ? meetings.map((meeting) => `• **${meeting.id}** ${safeDisplayText(meeting.title, 80)} — ${discordTimestamp(meeting.startsAtMs, "F")}`).join("\n")
      : "開催予定の会議はありません。";
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  async commandStatus(interaction) {
    try {
      const id = normalizeMeetingId(interaction.options.getString("id", true));
      const meeting = this.store.getMeeting(id);
      if (!meeting || meeting.guildId !== interaction.guildId) throw new Error("会議が見つかりません");
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
      if (!meeting || meeting.guildId !== interaction.guildId) throw new Error("会議が見つかりません");
      const cancelled = this.store.cancelMeeting(id);
      if (!cancelled) throw new Error("会議はすでに中止または終了しています");
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
      `3. 会議登録: ${mention} 来週月曜20:30から全体定例、URLは…（参加者を省略すると既定テンプレートを使用）`,
      "4. 黄色い確認画面で日時・URL登録済み・DM送信先を確認し、「登録する」を押します。",
      "5. 招待された人はボタンまたはDMで「参加します」「未定です」「欠席します」「1時間前と10分前に通知して」と返信できます。",
      "`/meeting` の全操作は、通常チャンネルでBotをメンションして自然な日本語でも実行できます。",
      "例: `会議一覧を見せて` / `MEET0001の出欠状況` / `MEET0001を中止して` / `自分の通知設定を見せて`",
      "※会議URL・Discord ID・登録した呼び名・テンプレート名・DM本文/回答はGPTへ送りません。本人操作はローカルで処理します。",
    ].join("\n");
  }
}
