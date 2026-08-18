import crypto from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { safeDisplayText } from "../privacy.mjs";

const CONSENT_POLICY_REVISION = "voice-local-24h-v1";
const ACTIVE_STATES = new Set(["pending_consent", "recording", "paused_for_consent", "stopping", "processing", "deleting"]);

function shortCode(error) {
  const value = String(error?.code || error?.status || error?.name || "voice_error").slice(0, 80);
  return /^[A-Za-z0-9_:-]{1,80}$/u.test(value) ? value : "voice_error";
}

function abortedError() {
  return Object.assign(new Error("VC議事録の処理は取り消されました"), { code: "ABORTED" });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedError();
}

function isAborted(error) {
  return error?.code === "ABORTED" || error?.name === "AbortError";
}

function awaitWithAbort(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sessionId() {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

function humanMembers(channel) {
  return [...(channel?.members?.values?.() || [])]
    .filter((member) => !member?.user?.bot)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function humanDisplayName(member, user) {
  return safeDisplayText(
    member?.displayName || user?.globalName || user?.username || "参加者",
    80,
  ) || "参加者";
}

function isDirectBotMention(message, botUserId) {
  const id = String(botUserId || "");
  if (!id) return false;
  if (message?.mentions?.users?.has?.(id)) return true;
  return String(message?.content || "").includes(`<@${id}>`)
    || String(message?.content || "").includes(`<@!${id}>`);
}

function isMeetingEndCommand(content, botUserId) {
  const id = String(botUserId || "");
  const rawWithoutMention = String(content || "")
    .replaceAll(`<@${id}>`, " ")
    .replaceAll(`<@!${id}>`, " ");
  if (/[?？]/u.test(rawWithoutMention)) return false;
  const withoutMention = rawWithoutMention
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　!！。、,.]+/gu, "");
  if (!withoutMention || withoutMention.length > 80) return false;
  return /^(?:(?:会議|ミーティング|mtg)(?:が|は|を)?(?:もう)?(?:終わった|終わり|終了|おしまい)(?:です|でした|だ)?(?:よ|ね)?|(?:会議|ミーティング|mtg)(?:を)?(?:終えて|終わって|終了して)(?:ください)?|(?:文字起こし|録音)(?:を)?(?:止めて|停止して)(?:ください)?|終わった(?:よ|ね)?|終わり|終了|おしまい|止めて|停止して)$/u.test(withoutMention);
}

function mergeTranscriptSegments(audioTranscript, chatSegments = []) {
  const audioSegments = Array.isArray(audioTranscript?.segments) ? audioTranscript.segments : [];
  return {
    version: 1,
    segments: [...audioSegments, ...chatSegments]
      .map((segment) => ({ ...segment }))
      .sort((left, right) => (
        Number(left.startMs || 0) - Number(right.startMs || 0)
        || Number(left.endMs || 0) - Number(right.endMs || 0)
      )),
  };
}

function buttonRows(id, { active = false, automatic = false } = {}) {
  if (active) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`voice:stop:${id}`)
        .setLabel("録音を停止")
        .setStyle(ButtonStyle.Danger),
    );
    if (!automatic) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`voice:withdraw:${id}`)
          .setLabel("同意を撤回して停止")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    return [row];
  }
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`voice:consent:${id}`)
      .setLabel("内容を確認して同意")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`voice:decline:${id}`)
      .setLabel("同意しない")
      .setStyle(ButtonStyle.Danger),
  )];
}

function recordingNotice({ id, title, automatic = false }) {
  return {
    content: [
      automatic ? "🔴 **自動文字起こしを開始しました**" : "🔴 **VC文字起こし中**",
      `セッション: **${safeDisplayText(id, 16)}** / ${safeDisplayText(title || "VCミーティング", 100)}`,
      automatic
        ? "このVCの音声をBotがローカル録音・文字起こししています。参加者の同意ボタン操作は不要です。"
        : "全参加者が同意しました。音声をローカル録音・文字起こししています。",
      "ローカルデータは開始から24時間以内に削除されます。誰でも下のボタンから停止できます。",
    ].join("\n"),
    components: buttonRows(id, { active: true, automatic }),
    allowedMentions: { parse: [] },
  };
}

function processingNotice({ id, title }) {
  return {
    content: [
      "⏳ **録音終了・ローカル文字起こし処理中**",
      `セッション: **${safeDisplayText(id, 16)}** / ${safeDisplayText(title || "VCミーティング", 100)}`,
      "BotはVCから退出済みです。保存済みの暗号化音声を、このPC内で文字起こし・議事録化しています。",
    ].join("\n"),
    components: [],
    allowedMentions: { parse: [] },
  };
}

function completedNotice({ id, title }) {
  return {
    content: [
      "✅ **文字起こし・議事録の処理が完了しました**",
      `セッション: **${safeDisplayText(id, 16)}** / ${safeDisplayText(title || "VCミーティング", 100)}`,
      "結果は議事録チャンネルへ投稿しました。",
    ].join("\n"),
    components: [],
    allowedMentions: { parse: [] },
  };
}

function failedNotice({ id, title }) {
  return {
    content: [
      "⚠️ **文字起こし・議事録の処理に失敗しました**",
      `セッション: **${safeDisplayText(id, 16)}** / ${safeDisplayText(title || "VCミーティング", 100)}`,
      "暗号化音声は24時間以内に管理者が再処理できます。",
    ].join("\n"),
    components: [],
    allowedMentions: { parse: [] },
  };
}

function consentNotice({ id, title, required, consented, summaryEnabled, factCheckEnabled, paused = false, automatic = false }) {
  return {
    content: [
      paused ? "⏸️ **新しい参加者の同意待ちのため録音を一時停止しています**" : "🎙️ **VC文字起こしの同意確認**",
      `セッション: **${safeDisplayText(id, 16)}** / ${safeDisplayText(title || "VCミーティング", 100)}`,
      `同意: **${consented}/${required}人**`,
      automatic
        ? "- 予定で指定されたDiscord VCへの入室を検知し、同意確認を自動で開始しました。"
        : "- 会議管理者の操作で同意確認を開始しました。",
      "- 音声は外部の文字起こしAPIへ送らず、このPCのローカルWhisperだけで処理します。",
      "- ローカル音声・文字起こし・一時要約は、開始から24時間を上限に自動削除します。",
      "- 音声そのものはDiscordへアップロードしません。文字起こしと要約はこの専用チャンネルへ送ります。",
      summaryEnabled
        ? "- 要約のため、URL・Discord ID・メール・話者名を除いた文字起こしだけを一時Codex処理へ送ります。"
        : "- AI要約は無効で、文字起こしのみ作成します。",
      factCheckEnabled
        ? "- 裏取りは、公開情報と判定され個人情報を除いた短い主張だけをWeb検索します。"
        : "- Web検索による裏取りは無効です。",
      "全員が同意するまでBotはVCへ入らず、音声を保存しません。",
    ].join("\n"),
    components: buttonRows(id),
    allowedMentions: { parse: [] },
  };
}

export class VoiceMeetingController {
  constructor({
    client,
    guildId,
    outputChannelId,
    archive,
    receiver,
    transcriber,
    analyzer = null,
    publisher = null,
    enabled = false,
    summaryEnabled = false,
    factCheckEnabled = false,
    maxSessionMinutes = 240,
    noticeIntervalMinutes = 30,
    maxParticipants = 20,
    canManage = () => false,
    validateAutomaticSession = null,
    releaseAutomaticSession = null,
    automaticValidationIntervalMs = 15_000,
    sessionWatchdogIntervalMs = 5_000,
    emptyVoiceGraceMs = 8_000,
    connectionLossGraceMs = 20_000,
    logger = console,
    now = () => Date.now(),
  } = {}) {
    this.client = client;
    this.guildId = String(guildId || "");
    this.outputChannelId = String(outputChannelId || "");
    this.archive = archive;
    this.receiver = receiver;
    this.transcriber = transcriber;
    this.analyzer = analyzer;
    this.publisher = publisher;
    this.enabled = Boolean(enabled);
    this.summaryEnabled = Boolean(summaryEnabled);
    this.factCheckEnabled = Boolean(factCheckEnabled);
    this.maxSessionMinutes = Math.max(5, Math.min(480, Number(maxSessionMinutes) || 240));
    this.noticeIntervalMinutes = Math.max(5, Math.min(120, Number(noticeIntervalMinutes) || 30));
    this.maxParticipants = Math.max(1, Math.min(50, Number(maxParticipants) || 20));
    this.canManage = canManage;
    this.validateAutomaticSession = typeof validateAutomaticSession === "function"
      ? validateAutomaticSession
      : null;
    this.releaseAutomaticSession = typeof releaseAutomaticSession === "function"
      ? releaseAutomaticSession
      : null;
    this.automaticValidationIntervalMs = Math.max(1_000, Math.min(60_000, Number(automaticValidationIntervalMs) || 15_000));
    this.sessionWatchdogIntervalMs = Math.max(1_000, Math.min(60_000, Number(sessionWatchdogIntervalMs) || 5_000));
    this.emptyVoiceGraceMs = Number.isFinite(Number(emptyVoiceGraceMs))
      ? Math.max(0, Math.min(60_000, Number(emptyVoiceGraceMs)))
      : 8_000;
    this.connectionLossGraceMs = Number.isFinite(Number(connectionLossGraceMs))
      ? Math.max(0, Math.min(120_000, Number(connectionLossGraceMs)))
      : 20_000;
    this.logger = logger;
    this.now = now;
    this.session = null;
    this.processing = new Map();
    this.processingAbortControllers = new Map();
    this.processingExpiryTimers = new Map();
    this.deletionTasks = new Map();
    this.maxTimer = null;
    this.noticeTimer = null;
    this.janitorTimer = null;
    this.automaticValidationTimer = null;
    this.sessionWatchdogTimer = null;
    this.emptyVoiceSinceMs = null;
    this.connectionLostAtMs = null;
    this.starting = false;
    this.closing = false;
    this.closePromise = null;
    this.operationTail = Promise.resolve();
    this.automaticPendingOutcomes = new Map();
  }

  runSessionOperation(operation) {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.catch(() => {});
    return run;
  }

  registerProcessing(session, operation) {
    const id = String(session.id);
    if (this.processing.has(id) || this.processingAbortControllers.has(id)) {
      throw new Error("このセッションはすでに処理中です");
    }
    const abortController = new AbortController();
    this.processingAbortControllers.set(id, abortController);
    const task = Promise.resolve().then(() => operation(abortController.signal));
    this.processing.set(id, task);
    const remainingMs = Number(session.expiresAtMs) - this.now();
    if (Number.isFinite(remainingMs)) {
      const expiryTimer = setTimeout(() => {
        void this.deleteSession(id, { reason: "expired" }).catch((error) => {
          this.logger.warn?.(`[voice] retention_delete_failed code=${shortCode(error)}`);
        });
      }, Math.max(0, Math.min(remainingMs, 0x7FFFFFFF)));
      expiryTimer.unref?.();
      this.processingExpiryTimers.set(id, expiryTimer);
    }
    const cleanup = () => {
      if (this.processing.get(id) === task) this.processing.delete(id);
      if (this.processingAbortControllers.get(id) === abortController) {
        this.processingAbortControllers.delete(id);
      }
      const expiryTimer = this.processingExpiryTimers.get(id);
      if (expiryTimer) clearTimeout(expiryTimer);
      this.processingExpiryTimers.delete(id);
    };
    task.then(cleanup, cleanup);
    return task;
  }

  async purgeExpiredSafely() {
    const nowMs = this.now();
    const candidates = new Set([
      ...(this.session?.expiresAtMs <= nowMs ? [this.session.id] : []),
      ...this.processing.keys(),
    ]);
    for (const id of candidates) {
      const record = await this.archive.getSession(id).catch(() => null);
      if (record?.expiresAtMs <= nowMs) await this.deleteSession(id, { reason: "expired" });
    }
    return this.archive.purgeExpired?.({
      nowMs,
      excludeSessionIds: [this.session?.id, ...this.processing.keys()].filter(Boolean),
    });
  }

  automaticSessionContext(session = this.session, extra = {}) {
    return {
      sourceMeetingId: session?.sourceMeetingId || null,
      voiceChannelId: session?.voiceChannel?.id || null,
      sessionId: session?.id || null,
      nowMs: this.now(),
      ...extra,
    };
  }

  startAutomaticValidationTimer() {
    clearInterval(this.automaticValidationTimer);
    this.automaticValidationTimer = null;
    if (!this.session?.automatic || !this.validateAutomaticSession) return;
    this.automaticValidationTimer = setInterval(() => {
      void this.runSessionOperation(() => this.validateAutomaticPending()).catch((error) => {
        this.logger.warn?.(`[voice] automatic_validation_failed code=${shortCode(error)}`);
      });
    }, this.automaticValidationIntervalMs);
    this.automaticValidationTimer.unref?.();
  }

  async validateAutomaticPending() {
    const session = this.session;
    if (!session?.automatic || session.state !== "pending_consent" || !this.validateAutomaticSession) return true;
    let result;
    try {
      result = await this.validateAutomaticSession(this.automaticSessionContext(session));
    } catch (error) {
      this.logger.warn?.(`[voice] automatic_validation_failed code=${shortCode(error)}`);
      await this.cancelPending("予定の有効性を確認できないため、自動文字起こしの開始待機を終了しました", {
        retryable: true,
        releaseReason: "schedule_validation_failed",
      });
      return false;
    }
    const valid = result === true || result?.valid === true;
    if (valid) return true;
    await this.cancelPending("予定が終了・変更・中止されたため、自動文字起こしの開始待機を終了しました", {
      retryable: true,
      releaseReason: String(result?.reason || "schedule_invalid"),
    });
    return false;
  }

  async initialize() {
    if (!this.enabled) return { enabled: false };
    await this.archive.initialize?.();
    const purge = await this.archive.purgeExpired?.({ nowMs: this.now() });
    if (purge?.failed) {
      throw Object.assign(new Error("期限切れ音声データを削除できないためVC録音を開始できません"), { code: "voice_purge_failed" });
    }
    await this.reconcileInterruptedNotices();
    this.janitorTimer = setInterval(() => {
      void this.purgeExpiredSafely().catch((error) => {
        this.logger.warn?.(`[voice] retention_purge_failed code=${shortCode(error)}`);
      });
    }, 60_000);
    this.janitorTimer.unref?.();
    return { enabled: true };
  }

  async reconcileInterruptedNotices() {
    if (typeof this.archive?.listSessions !== "function") return 0;
    const records = await this.archive.listSessions({ states: ["processing_failed"], limit: 100 });
    const interrupted = records.filter((record) => record?.failureCode === "PROCESS_INTERRUPTED" && record.noticeMessageId);
    if (!interrupted.length) return 0;
    let updated = 0;
    let guild;
    try {
      guild = await this.client.guilds.fetch(this.guildId);
    } catch (error) {
      this.logger.warn?.(`[voice] interrupted_notice_guild_failed code=${shortCode(error)}`);
      return 0;
    }
    for (const record of interrupted) {
      const channelIds = [...new Set([record.voiceChannelId, record.outputChannelId].filter(Boolean).map(String))];
      let edited = false;
      for (const channelId of channelIds) {
        try {
          const channel = await guild.channels.fetch(channelId);
          if (!channel?.messages?.fetch) continue;
          const notice = await channel.messages.fetch(record.noticeMessageId);
          await notice.edit(failedNotice(record));
          edited = true;
          updated += 1;
          break;
        } catch {}
      }
      if (!edited) this.logger.warn?.("[voice] interrupted_notice_update_failed code=NOTICE_NOT_FOUND");
    }
    return updated;
  }

  async updateSessionNotice(session, payload, logCode = "notice_update_failed") {
    if (!session?.noticeMessageId) return false;
    try {
      const notice = await (session.noticeChannel || session.outputChannel).messages.fetch(session.noticeMessageId);
      await notice.edit(payload);
      return true;
    } catch (error) {
      this.logger.warn?.(`[voice] ${logCode} code=${shortCode(error)}`);
      return false;
    }
  }

  startSessionWatchdog() {
    clearInterval(this.sessionWatchdogTimer);
    this.sessionWatchdogTimer = setInterval(() => {
      void this.runSessionOperation(() => this.reconcileActiveSession()).catch((error) => {
        this.logger.warn?.(`[voice] session_watchdog_failed code=${shortCode(error)}`);
      });
    }, this.sessionWatchdogIntervalMs);
    this.sessionWatchdogTimer.unref?.();
  }

  async reconcileActiveSession() {
    const session = this.session;
    if (!session || !["recording", "paused_for_consent"].includes(session.state)) return false;
    if (!humanMembers(session.voiceChannel).length) {
      if (this.emptyVoiceSinceMs == null) {
        this.emptyVoiceSinceMs = this.now();
        return false;
      }
      if (this.now() - this.emptyVoiceSinceMs < this.emptyVoiceGraceMs) return false;
      await this.stopSessionInternal({ reason: "voice_empty", requestedById: "system" });
      return true;
    }
    this.emptyVoiceSinceMs = null;
    if (typeof this.receiver?.isConnected !== "function") return false;
    const connected = this.receiver.isConnected({
      guildId: session.guild.id,
      voiceChannelId: session.voiceChannel.id,
      sessionId: session.id,
    });
    if (connected) {
      this.connectionLostAtMs = null;
      return false;
    }
    if (this.connectionLostAtMs == null) {
      this.connectionLostAtMs = this.now();
      return false;
    }
    if (this.now() - this.connectionLostAtMs < this.connectionLossGraceMs) return false;
    await this.stopSessionInternal({ reason: "voice_connection_lost", requestedById: "system" });
    return true;
  }

  privacyText() {
    return [
      "**VC文字起こしのプライバシー**",
      "- 予定で指定されたVCでは、参加者の入室を検知するとBotが自動参加して文字起こしを開始します。",
      "- 自動開始では同意ボタンを待たず、開始したことをVCチャットへ通知します。手動開始では従来どおり同意確認を行います。",
      "- 自動録音中に新しい参加者が入った場合は、チャット通知を増やさず文字起こし対象へ追加します。",
      "- Discordの音声はユーザー別ストリームの送信者情報で話者を確定し、最終TXTに実際の表示名・時刻・発言を記録します。",
      "- 読み上げBotの音声は除外し、録音中のVCチャット原文を投稿者名付きで取り込みます。",
      "- 音声はこのPCだけで文字起こしし、外部STT APIへ送りません。",
      "- ローカル音声・文字起こしは開始から24時間で削除します。管理者は早期削除もできます。",
      "- 音声はDiscordへ送信しません。文字起こし・要約は設定された議事録チャンネルへ投稿され、Discord側では24時間後も残ります。",
      this.summaryEnabled
        ? "- AI要約は話者名・URL・Discord ID・メール等をローカル除去してからCodexへ送ります。"
        : "- AI要約は現在無効です。",
      this.factCheckEnabled
        ? "- 裏取りは個人情報を含まない公開事実の短い主張だけを検索します。"
        : "- Web検索による裏取りは現在無効です。",
    ].join("\n");
  }

  statusText(subject = null) {
    if (!this.enabled) return "VC文字起こし機能は無効です。";
    if (!this.session) return "現在、VC文字起こしセッションはありません。";
    const canSee = this.canManage(subject)
      || this.session.requiredUserIds.has(String(subject?.user?.id || subject?.author?.id || ""));
    if (!canSee) return "現在のVC参加者または会議管理者だけが状態を確認できます。";
    return [
      `状態: **${this.session.state}**`,
      `セッション: **${safeDisplayText(this.session.id, 16)}**`,
      this.session.automatic
        ? `文字起こし対象: **${this.session.requiredUserIds.size}人**`
        : `同意: **${this.session.consentedUserIds.size}/${this.session.requiredUserIds.size}人**`,
      `ローカル削除期限: <t:${Math.floor(this.session.expiresAtMs / 1_000)}:R>`,
    ].join("\n");
  }

  async validateOutputChannel(guild, members) {
    const channel = await guild.channels.fetch(this.outputChannelId);
    if (!channel || channel.guildId !== guild.id || channel.type !== ChannelType.GuildText) {
      throw new Error("専用の議事録テキストチャンネルを確認できません");
    }
    const botPermissions = channel.permissionsFor(guild.members.me || this.client.user);
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    if (!botPermissions?.has?.(required)) throw new Error("Botに議事録チャンネルの表示・送信・添付・履歴権限が必要です");
    return channel;
  }

  async requestStart(subject, { title = "VCミーティング" } = {}) {
    if (this.closing) throw new Error("VC文字起こし機能を終了中です");
    const guild = await this.client.guilds.fetch(this.guildId);
    const actorId = String(subject?.user?.id || subject?.author?.id || "");
    const actor = await guild.members.fetch(actorId);
    const voiceChannel = actor.voice?.channel;
    if (!voiceChannel || voiceChannel.guildId !== guild.id || voiceChannel.type === ChannelType.GuildStageVoice) {
      throw new Error("開始する本人が通常のDiscord VCへ入ってから実行してください");
    }
    return this.requestStartForVoiceChannel({
      guild,
      voiceChannel,
      requestedById: actor.id,
      title,
      automatic: false,
    });
  }

  async requestStartForVoiceChannel({
    guild: providedGuild = null,
    voiceChannel,
    requestedById = "system",
    title = "VCミーティング",
    automatic = false,
    sourceMeetingId = null,
  } = {}) {
    if (this.closing) throw new Error("VC文字起こし機能を終了中です");
    if (!this.enabled) throw new Error("VC文字起こし機能は設定されていません");
    if (this.starting) throw new Error("VC文字起こしの開始処理が進行中です");
    if (this.session && ACTIVE_STATES.has(this.session.state)) throw new Error("すでにVC文字起こしセッションが動作中です");
    if (this.processing.size) throw new Error("前のVC文字起こしを処理中です。完了後に開始してください");
    this.starting = true;
    try {
      const guild = providedGuild || await this.client.guilds.fetch(this.guildId);
      if (!voiceChannel || voiceChannel.guildId !== guild.id || voiceChannel.type !== ChannelType.GuildVoice) {
        throw new Error("予定で指定された通常のDiscord VCを確認できません");
      }
      const botVoicePermissions = voiceChannel.permissionsFor?.(guild.members.me || this.client.user);
      if (!botVoicePermissions?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
        throw new Error("Botに指定VCのチャンネル表示・接続権限が必要です");
      }
    const members = humanMembers(voiceChannel);
    if (!members.length || members.length > this.maxParticipants) {
      throw new Error(`VC参加者は1〜${this.maxParticipants}人の範囲で開始してください`);
    }
    const outputChannel = await this.validateOutputChannel(guild, members);
    const id = sessionId();
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + 24 * 60 * 60_000;
    const requiredUserIds = new Set(members.map((member) => String(member.id)));
    const automaticMode = Boolean(automatic);
    const record = await this.archive.createSession({
      sessionId: id,
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      outputChannelId: outputChannel.id,
      requestedById: String(requestedById),
      sourceMeetingId: sourceMeetingId ? String(sourceMeetingId) : null,
      title: safeDisplayText(title, 100) || "VCミーティング",
      state: "pending_consent",
      policyRevision: CONSENT_POLICY_REVISION,
      createdAtMs,
      expiresAtMs,
      requiredUserIds: [...requiredUserIds],
      consentedUserIds: automaticMode ? [...requiredUserIds] : [],
    });
    const notice = automaticMode ? null : await outputChannel.send(consentNotice({
      id,
      title: record.title || title,
      required: requiredUserIds.size,
      consented: 0,
      summaryEnabled: this.summaryEnabled,
      factCheckEnabled: this.factCheckEnabled,
      automatic: false,
    }));
    this.session = {
      id,
      guild,
      voiceChannel,
      outputChannel,
      noticeMessageId: notice?.id || null,
      noticeChannel: notice ? outputChannel : null,
      requestedById: String(requestedById),
      sourceMeetingId: sourceMeetingId ? String(sourceMeetingId) : null,
      automatic: automaticMode,
      automaticReady: !automaticMode,
      title: record.title || safeDisplayText(title, 100),
      state: "pending_consent",
      createdAtMs,
      expiresAtMs,
      requiredUserIds,
      consentedUserIds: automaticMode ? new Set(requiredUserIds) : new Set(),
      chatSegments: [],
      capturedMessageIds: new Set(),
      participantUserIds: new Set(requiredUserIds),
    };
    if (notice) await this.archive.updateSession(id, { noticeMessageId: notice.id });
    return { sessionId: id, required: requiredUserIds.size, outputChannelId: outputChannel.id };
    } finally {
      this.starting = false;
    }
  }

  async updateConsentNotice({ paused = false } = {}) {
    const session = this.session;
    if (!session || !session.noticeMessageId) return;
    try {
      const notice = await (session.noticeChannel || session.outputChannel).messages.fetch(session.noticeMessageId);
      await notice.edit(consentNotice({
        id: session.id,
        title: session.title,
        required: session.requiredUserIds.size,
        consented: [...session.requiredUserIds].filter((id) => session.consentedUserIds.has(id)).length,
        summaryEnabled: this.summaryEnabled,
        factCheckEnabled: this.factCheckEnabled,
        paused,
        automatic: session.automatic,
      }));
    } catch (error) {
      this.logger.warn?.(`[voice] consent_notice_update_failed code=${shortCode(error)}`);
    }
  }

  async consent(subject) {
    return this.runSessionOperation(() => this.consentInternal(subject));
  }

  async consentInternal(subject) {
    const session = this.session;
    if (!session || !["pending_consent", "paused_for_consent"].includes(session.state)) {
      throw new Error("同意できるVC文字起こしセッションがありません");
    }
    const userId = String(subject.user?.id || subject.author?.id || "");
    const member = await session.guild.members.fetch(userId);
    if (String(member.voice?.channelId || "") !== String(session.voiceChannel.id)) {
      throw new Error("対象VCへ現在参加している本人だけが同意できます");
    }
    session.requiredUserIds.add(userId);
    session.consentedUserIds.add(userId);
    await this.archive.updateSession(session.id, {
      state: session.state,
      requiredUserIds: [...session.requiredUserIds],
      consentedUserIds: [...session.consentedUserIds],
      consent: { userId, decision: "allow", decidedAtMs: this.now(), policyRevision: CONSENT_POLICY_REVISION },
    });
    const allConsented = [...session.requiredUserIds].every((id) => session.consentedUserIds.has(id));
    let activated = false;
    if (allConsented) {
      if (session.state === "pending_consent") {
        if (!session.automatic || session.automaticReady) activated = await this.beginRecording();
      } else {
        activated = await this.resumeRecording();
      }
    } else {
      await this.updateConsentNotice({ paused: session.state === "paused_for_consent" });
    }
    return {
      allConsented: allConsented && activated,
      consented: session.consentedUserIds.size,
      required: session.requiredUserIds.size,
    };
  }

  async decline(subject, { withdraw = false } = {}) {
    return this.runSessionOperation(() => this.declineInternal(subject, { withdraw }));
  }

  async declineInternal(subject, { withdraw = false } = {}) {
    const session = this.session;
    if (!session) throw new Error("対象のVC文字起こしセッションがありません");
    const userId = String(subject.user?.id || subject.author?.id || "");
    if (!session.requiredUserIds.has(userId)) throw new Error("対象VCの参加者だけが操作できます");
    await this.archive.updateSession(session.id, {
      consent: { userId, decision: withdraw ? "withdraw" : "deny", decidedAtMs: this.now(), policyRevision: CONSENT_POLICY_REVISION },
    });
    if (session.state === "pending_consent") {
      await this.cancelPending("参加者が同意しなかったため開始を取り消しました", {
        retryable: false,
        releaseReason: withdraw ? "consent_withdrawn" : "consent_denied",
      });
      return { cancelled: true };
    }
    await this.stopSessionInternal({ reason: "consent_withdrawn", requestedById: userId });
    return { stopped: true };
  }

  async beginRecording() {
    const session = this.session;
    if (!session || session.state !== "pending_consent") return false;
    if (session.automatic && !session.automaticReady) return false;
    if (!(await this.validateAutomaticPending())) return false;
    if (this.session !== session || session.state !== "pending_consent") return false;
    const currentMembers = humanMembers(session.voiceChannel);
    if (!currentMembers.length) {
      await this.cancelPending("VCが空になったため、自動文字起こしの開始待機を終了しました", {
        retryable: session.automatic,
        releaseReason: "voice_empty",
      });
      return false;
    }
    try {
      await this.validateOutputChannel(session.guild, currentMembers);
    } catch (error) {
      await this.cancelPending("Botが議事録チャンネルを利用できないため、録音を開始しませんでした", {
        retryable: false,
        releaseReason: "output_channel_forbidden",
      });
      return false;
    }
    const currentIds = new Set(currentMembers.map((member) => String(member.id)));
    session.requiredUserIds = currentIds;
    if (session.automatic) {
      session.consentedUserIds = new Set(currentIds);
    }
    const allConsented = [...currentIds].every((id) => session.consentedUserIds.has(id));
    if (!allConsented) {
      await this.updateConsentNotice();
      return false;
    }
    const activeNotice = recordingNotice({
      id: session.id,
      title: session.title,
      automatic: session.automatic,
    });
    await this.receiver.start({
      guild: session.guild,
      voiceChannelId: session.voiceChannel.id,
      sessionId: session.id,
      consentedUserIds: session.consentedUserIds,
    });
    try {
      if (session.automatic && !session.noticeMessageId) {
        let noticeChannel = session.voiceChannel;
        let notice;
        try {
          if (typeof noticeChannel?.send !== "function") throw new Error("voice_chat_unavailable");
          notice = await noticeChannel.send(activeNotice);
        } catch {
          noticeChannel = session.outputChannel;
          notice = await noticeChannel.send(activeNotice);
        }
        session.noticeChannel = noticeChannel;
        session.noticeMessageId = notice.id;
      }
      if (!session.automatic && session.noticeMessageId) {
        const notice = await (session.noticeChannel || session.outputChannel).messages.fetch(session.noticeMessageId);
        await notice.edit(activeNotice);
      }
    } catch (error) {
      await this.receiver.stop({ discardActive: true }).catch(() => {});
      await this.cancelPending("文字起こし開始通知を表示できないため、録音を開始しませんでした", {
        retryable: session.automatic,
        releaseReason: "recording_notice_failed",
      });
      throw error;
    }
    try {
      clearInterval(this.automaticValidationTimer);
      this.automaticValidationTimer = null;
      session.state = "recording";
      session.startedAtMs = this.now();
      this.emptyVoiceSinceMs = null;
      this.connectionLostAtMs = null;
      await this.archive.updateSession(session.id, {
        state: "recording",
        startedAtMs: this.now(),
        requiredUserIds: [...session.requiredUserIds],
        consentedUserIds: [...session.consentedUserIds],
        noticeMessageId: session.noticeMessageId,
      });
    } catch (error) {
      await this.receiver.stop({ discardActive: true }).catch(() => {});
      session.state = "pending_consent";
      await this.cancelPending("録音開始状態を安全に保存できないため、録音を停止しました", {
        retryable: session.automatic,
        releaseReason: "recording_state_persist_failed",
      }).catch(() => {});
      throw error;
    }
    this.maxTimer = setTimeout(() => {
      void this.stopSession({ reason: "max_duration", requestedById: "system" });
    }, this.maxSessionMinutes * 60_000);
    this.maxTimer.unref?.();
    this.startSessionWatchdog();
    return true;
  }

  async pauseForConsent(userId) {
    const session = this.session;
    if (!session || !["recording", "paused_for_consent"].includes(session.state)) return false;
    await this.receiver.pause();
    session.state = "paused_for_consent";
    session.requiredUserIds.add(String(userId));
    session.consentedUserIds.delete(String(userId));
    this.receiver.setConsentedUserIds(session.consentedUserIds);
    await this.archive.updateSession(session.id, {
      state: session.state,
      requiredUserIds: [...session.requiredUserIds],
      consentedUserIds: [...session.consentedUserIds],
    });
    await this.updateConsentNotice({ paused: true });
    return true;
  }

  async resumeRecording() {
    const session = this.session;
    if (!session || session.state !== "paused_for_consent") return false;
    const currentIds = new Set(humanMembers(session.voiceChannel).map((member) => String(member.id)));
    session.requiredUserIds = currentIds;
    if (![...currentIds].every((id) => session.consentedUserIds.has(id))) return false;
    this.receiver.setConsentedUserIds(session.consentedUserIds);
    this.receiver.resume();
    session.state = "recording";
    await this.archive.updateSession(session.id, {
      state: "recording",
      requiredUserIds: [...session.requiredUserIds],
      consentedUserIds: [...session.consentedUserIds],
    });
    const notice = await session.outputChannel.messages.fetch(session.noticeMessageId);
    await notice.edit({
      content: `🔴 **VC文字起こしを再開しました** — セッション **${safeDisplayText(session.id, 16)}**`,
      components: buttonRows(session.id, { active: true, automatic: session.automatic }),
      allowedMentions: { parse: [] },
    });
    return true;
  }

  async handleVoiceStateUpdate(oldState, newState) {
    return this.runSessionOperation(() => this.handleVoiceStateUpdateInternal(oldState, newState));
  }

  async handleVoiceStateUpdateInternal(oldState, newState) {
    const session = this.session;
    if (!session || !["pending_consent", "recording", "paused_for_consent"].includes(session.state)) return false;
    const user = newState?.member?.user || oldState?.member?.user;
    if (!user || user.bot || String(newState.guild?.id || oldState.guild?.id || "") !== this.guildId) return false;
    const userId = String(user.id);
    const joined = String(newState.channelId || "") === String(session.voiceChannel.id)
      && String(oldState.channelId || "") !== String(session.voiceChannel.id);
    const left = String(oldState.channelId || "") === String(session.voiceChannel.id)
      && String(newState.channelId || "") !== String(session.voiceChannel.id);
    if (joined) this.emptyVoiceSinceMs = null;
    if (session.state === "pending_consent" && joined) {
      session.participantUserIds.add(userId);
      session.requiredUserIds.add(userId);
      if (session.automatic) session.consentedUserIds.add(userId);
      else session.consentedUserIds.delete(userId);
      await this.archive.updateSession(session.id, {
        state: session.state,
        requiredUserIds: [...session.requiredUserIds],
        consentedUserIds: [...session.consentedUserIds],
      });
      if (!session.automatic) await this.updateConsentNotice();
      return true;
    }
    if (session.state === "pending_consent" && left) {
      session.requiredUserIds.delete(userId);
      session.consentedUserIds.delete(userId);
      const remaining = humanMembers(session.voiceChannel);
      if (!remaining.length) {
        await this.cancelPending("VCが空になったため、自動文字起こしの開始待機を終了しました", {
          retryable: session.automatic,
          releaseReason: "voice_empty",
        });
        return true;
      }
      await this.archive.updateSession(session.id, {
        state: session.state,
        requiredUserIds: [...session.requiredUserIds],
        consentedUserIds: [...session.consentedUserIds],
      });
      if (session.automatic && session.automaticReady) {
        await this.beginRecording();
      } else if ([...session.requiredUserIds].every((id) => session.consentedUserIds.has(id))) {
        await this.beginRecording();
      } else {
        await this.updateConsentNotice();
      }
      return true;
    }
    if (joined && session.automatic) {
      session.participantUserIds.add(userId);
      session.requiredUserIds.add(userId);
      session.consentedUserIds.add(userId);
      this.receiver.setConsentedUserIds(session.consentedUserIds);
      await this.archive.updateSession(session.id, {
        state: session.state,
        requiredUserIds: [...session.requiredUserIds],
        consentedUserIds: [...session.consentedUserIds],
      });
      return true;
    }
    if (joined && !session.consentedUserIds.has(userId)) {
      await this.pauseForConsent(userId);
      return true;
    }
    if (left) {
      session.requiredUserIds.delete(userId);
      if (session.automatic) {
        session.consentedUserIds.delete(userId);
        this.receiver.setConsentedUserIds(session.consentedUserIds);
      }
      const remaining = humanMembers(session.voiceChannel);
      if (!remaining.length) {
        if (this.emptyVoiceSinceMs == null) this.emptyVoiceSinceMs = this.now();
        return true;
      }
      if (session.automatic) {
        await this.archive.updateSession(session.id, {
          state: session.state,
          requiredUserIds: [...session.requiredUserIds],
          consentedUserIds: [...session.consentedUserIds],
        });
      } else if (session.state === "paused_for_consent"
          && [...session.requiredUserIds].every((id) => session.consentedUserIds.has(id))) {
        await this.resumeRecording();
      } else {
        await this.updateConsentNotice({ paused: session.state === "paused_for_consent" });
      }
      return true;
    }
    return false;
  }

  async handleMessageCreate(message) {
    return this.runSessionOperation(async () => {
      const session = this.session;
      if (!session || session.state !== "recording") return false;
      if (String(message?.guildId || "") !== this.guildId) return false;
      if (String(message?.channelId || message?.channel?.id || "") !== String(session.voiceChannel.id)) return false;
      if (!message?.author || message.author.bot) return false;
      const content = String(message.content || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ").trim();
      if (!content) return false;
      const messageId = String(message.id || "");
      if (messageId && session.capturedMessageIds.has(messageId)) return true;
      const createdAtMs = Number(message.createdTimestamp || message.createdAt?.getTime?.() || this.now());
      const relativeMs = Math.max(0, createdAtMs - Number(session.startedAtMs || session.createdAtMs));
      session.chatSegments.push({
        speakerId: String(message.author.id || "unknown"),
        speakerName: humanDisplayName(message.member, message.author),
        startMs: relativeMs,
        endMs: relativeMs,
        text: `[チャット] ${content}`,
        language: null,
      });
      if (messageId) session.capturedMessageIds.add(messageId);
      return true;
    });
  }

  async handleMeetingEndMessage(message) {
    return this.runSessionOperation(async () => {
      const session = this.session;
      if (!session || !["recording", "paused_for_consent"].includes(session.state)) return false;
      if (String(message?.guildId || "") !== this.guildId) return false;
      if (String(message?.channelId || message?.channel?.id || "") !== String(session.voiceChannel.id)) return false;
      if (!message?.author || message.author.bot) return false;
      if (!isDirectBotMention(message, this.client?.user?.id)) return false;
      if (!isMeetingEndCommand(message.content, this.client?.user?.id)) return false;
      const userId = String(message.author.id || "");
      const authorized = this.canManage(message)
        || session.participantUserIds.has(userId)
        || String(message.member?.voice?.channelId || "") === String(session.voiceChannel.id);
      if (!authorized) return false;
      await this.stopSessionInternal({ reason: "meeting_end_message", requestedById: userId });
      await message.react?.("✅").catch?.(() => {});
      return true;
    });
  }

  async confirmAutomaticPending(expectedSessionId) {
    return this.runSessionOperation(async () => {
      const session = this.session;
      if (!session?.automatic || session.state !== "pending_consent") return false;
      if (String(expectedSessionId || "") !== String(session.id)) return false;
      session.automaticReady = true;
      this.startAutomaticValidationTimer();
      const allConsented = [...session.requiredUserIds].every((id) => session.consentedUserIds.has(id));
      if (!allConsented) return true;
      return this.beginRecording();
    });
  }

  consumeAutomaticPendingOutcome(expectedSessionId) {
    const id = String(expectedSessionId || "");
    const outcome = this.automaticPendingOutcomes.get(id) || null;
    this.automaticPendingOutcomes.delete(id);
    return outcome ? { ...outcome } : null;
  }

  async cancelAutomaticPending({
    expectedSessionId = null,
    reason = "automatic_cancelled",
    retryable = true,
  } = {}) {
    return this.runSessionOperation(async () => {
      const session = this.session;
      if (!session?.automatic || session.state !== "pending_consent") return false;
      if (expectedSessionId && String(expectedSessionId) !== String(session.id)) return false;
      await this.cancelPending("自動議事録の開始確認を取り消しました", {
        retryable,
        releaseReason: reason,
      });
      return true;
    });
  }

  async validateAutomaticPendingNow() {
    return this.runSessionOperation(() => this.validateAutomaticPending());
  }

  async cancelPending(reason, { retryable = false, releaseReason = "pending_cancelled" } = {}) {
    const session = this.session;
    if (!session) return;
    clearTimeout(this.maxTimer);
    clearInterval(this.noticeTimer);
    clearInterval(this.automaticValidationTimer);
    clearInterval(this.sessionWatchdogTimer);
    this.automaticValidationTimer = null;
    this.sessionWatchdogTimer = null;
    this.emptyVoiceSinceMs = null;
    this.connectionLostAtMs = null;
    const releaseContext = this.automaticSessionContext(session, {
      reason: String(releaseReason || "pending_cancelled"),
    });
    if (session.automatic) {
      this.automaticPendingOutcomes.set(String(session.id), {
        retryable: Boolean(retryable),
        reason: releaseContext.reason,
      });
      while (this.automaticPendingOutcomes.size > 100) {
        this.automaticPendingOutcomes.delete(this.automaticPendingOutcomes.keys().next().value);
      }
    }
    try {
      if (session.noticeMessageId) {
        const notice = await (session.noticeChannel || session.outputChannel).messages.fetch(session.noticeMessageId);
        await notice.edit({ content: safeDisplayText(reason, 300), components: [], allowedMentions: { parse: [] } });
      }
    } catch {}
    await this.archive.deleteSession(session.id);
    this.session = null;
    if (retryable && session.automatic && this.releaseAutomaticSession) {
      try {
        await this.releaseAutomaticSession(releaseContext);
      } catch (error) {
        this.logger.warn?.(`[voice] automatic_release_failed code=${shortCode(error)}`);
      }
    }
  }

  async stopSession({ reason = "manual", requestedById = "system" } = {}) {
    if (this.closing) return { stopped: false, closing: true };
    return this.runSessionOperation(() => this.stopSessionInternal({ reason, requestedById }));
  }

  async stopSessionInternal({ reason = "manual", requestedById = "system" } = {}) {
    const session = this.session;
    if (!session) return { stopped: false };
    if (session.state === "deleting") return { stopped: true, processing: false, deleting: true };
    if (["stopping", "processing"].includes(session.state)) return { stopped: true, processing: true };
    clearTimeout(this.maxTimer);
    clearInterval(this.noticeTimer);
    clearInterval(this.automaticValidationTimer);
    clearInterval(this.sessionWatchdogTimer);
    this.automaticValidationTimer = null;
    this.sessionWatchdogTimer = null;
    this.emptyVoiceSinceMs = null;
    this.connectionLostAtMs = null;
    session.state = "stopping";
    await this.archive.updateSession(session.id, { state: "stopping", stopReason: reason, stoppedById: requestedById });
    await this.receiver.stop();
    session.state = "processing";
    await this.archive.updateSession(session.id, { state: "processing", stoppedAtMs: this.now() });
    await this.updateSessionNotice(session, processingNotice(session), "processing_notice_update_failed");
    await session.outputChannel.send({
      content: `⏳ セッション **${safeDisplayText(session.id, 16)}** は録音終了・VC退出済みです。保存済み音声をこのPCで文字起こししています。`,
      allowedMentions: { parse: [] },
    }).catch((error) => {
      this.logger.warn?.(`[voice] processing_message_send_failed code=${shortCode(error)}`);
    });
    const processPromise = this.registerProcessing(
      session,
      (signal) => this.processSession(session, { signal }),
    );
    this.session = null;
    return { stopped: true, processing: true, sessionId: session.id };
  }

  async processSession(session, { signal = undefined } = {}) {
    try {
      throwIfAborted(signal);
      const audioTranscript = await this.transcriber.transcribeSession(session.id, { signal });
      throwIfAborted(signal);
      const transcript = mergeTranscriptSegments(audioTranscript, session.chatSegments);
      await this.archive.writeTranscript(session.id, transcript);
      throwIfAborted(signal);
      const outcome = await this.analyzeAndPublish(session, transcript, { signal });
      await this.updateSessionNotice(session, completedNotice(session), "completed_notice_update_failed");
      return { ok: true, aiUsed: outcome.aiUsed === true };
    } catch (error) {
      if (isAborted(error)) return { ok: false, code: "ABORTED", aborted: true };
      if (signal?.aborted) {
        const code = shortCode(error);
        this.logger.error?.(`[voice] cancellation_cleanup_failed code=${code}`);
        await session.outputChannel.send({
          content: `⚠️ VC議事録の削除確認を完了できませんでした。管理者は再起動前にログの固定エラーコードを確認してください。エラーコード: ${code}`,
          allowedMentions: { parse: [] },
        }).catch(() => {});
        return { ok: false, code, cancellationFailed: true };
      }
      await this.archive.updateSession(session.id, { state: "processing_failed", failureCode: shortCode(error) }).catch(() => {});
      await this.updateSessionNotice(session, failedNotice(session), "failed_notice_update_failed");
      await session.outputChannel.send({
        content: [
          `⚠️ セッション **${safeDisplayText(session.id, 16)}** の自動処理に失敗しました。`,
          "音声バックアップはローカルに暗号化して保持しており、開始から24時間以内に削除されます。管理者が再処理できます。",
          `エラーコード: ${safeDisplayText(shortCode(error), 80)}`,
        ].join("\n"),
        allowedMentions: { parse: [] },
      }).catch(() => {});
      return { ok: false, code: shortCode(error) };
    }
  }

  async analyzeAndPublish(session, transcript, { signal = undefined } = {}) {
    throwIfAborted(signal);
    const analysis = this.analyzer
      ? await awaitWithAbort(
        this.analyzer.analyze(transcript, { knownNames: transcript.segments?.map((item) => item.speakerName) || [] }),
        signal,
      )
      : { aiUsed: false, factCheckUsed: false, minutes: null, factChecks: [] };
    throwIfAborted(signal);
    await this.archive.writeAnalysis?.(session.id, analysis);
    throwIfAborted(signal);
    if (this.publisher) {
      await this.publisher.publish({
        session: { ...session, state: "review_pending" },
        transcript,
        analysis,
        signal,
      });
    }
    throwIfAborted(signal);
    await this.archive.updateSession(session.id, { state: "review_pending", completedAtMs: this.now() });
    return { ok: true, aiUsed: analysis.aiUsed === true };
  }

  async reprocess(sessionIdValue) {
    if (this.closing) throw new Error("VC文字起こし機能を終了中です");
    const id = String(sessionIdValue || "").trim().toUpperCase();
    if (!/^[A-F0-9]{10}$/u.test(id)) throw new Error("セッションIDの形式が正しくありません");
    return this.runSessionOperation(async () => {
      if (this.processing.has(id)) throw new Error("このセッションはすでに処理中です");
      const record = await this.archive.getSession(id);
      if (!record || record.guildId !== this.guildId || record.expiresAtMs <= this.now()) {
        throw new Error("再処理できるローカル音声が見つかりません");
      }
      if (record.state !== "processing_failed") {
        throw new Error("失敗状態のセッションだけ再処理できます");
      }
      const guild = await this.client.guilds.fetch(this.guildId);
      const outputChannel = await guild.channels.fetch(record.outputChannelId);
      const claimed = await this.archive.transitionSession(id, ["processing_failed"], {
        state: "reprocessing",
        failureCode: null,
      });
      if (!claimed) throw new Error("このセッションは別の処理が開始済みです");
      const session = { ...claimed, guild, outputChannel, id };
      const task = this.registerProcessing(session, (signal) => this.processSession(session, { signal }));
      return { sessionId: id, processing: true, task };
    });
  }

  async reanalyze(sessionIdValue) {
    if (this.closing) throw new Error("VC文字起こし機能を終了中です");
    const id = String(sessionIdValue || "").trim().toUpperCase();
    if (!/^[A-F0-9]{10}$/u.test(id)) throw new Error("セッションIDの形式が正しくありません");
    const prepared = await this.runSessionOperation(async () => {
      if (this.processing.has(id)) throw new Error("このセッションはすでに処理中です");
      const record = await this.archive.getSession(id);
      if (!record || record.guildId !== this.guildId || record.expiresAtMs <= this.now()) {
        throw new Error("再処理できるローカル音声が見つかりません");
      }
      if (!["review_pending", "analysis_failed"].includes(record.state)) {
        throw new Error("文字起こし完了後のセッションだけ要約を再生成できます");
      }
      const transcript = await this.archive.readTranscript?.(id);
      if (!transcript?.segments || !Array.isArray(transcript.segments)) {
        throw new Error("再利用できる文字起こしが見つかりません");
      }
      const guild = await this.client.guilds.fetch(this.guildId);
      const outputChannel = await guild.channels.fetch(record.outputChannelId);
      const claimed = await this.archive.transitionSession(id, ["review_pending", "analysis_failed"], {
        state: "reanalyzing",
        failureCode: null,
      });
      if (!claimed) throw new Error("このセッションは別の処理が開始済みです");
      const session = { ...claimed, guild, outputChannel, id };
      const task = this.registerProcessing(session, async (signal) => {
        try {
          return await this.analyzeAndPublish(session, transcript, { signal });
        } catch (error) {
          if (isAborted(error)) throw error;
          await this.archive.updateSession(id, {
            state: "analysis_failed",
            failureCode: shortCode(error),
          }).catch(() => {});
          throw error;
        }
      });
      return { task };
    });
    return prepared.task;
  }

  async deleteSession(sessionIdValue, { reason = "deleted" } = {}) {
    const id = String(sessionIdValue || "").trim().toUpperCase();
    if (!/^[A-F0-9]{10}$/u.test(id)) throw new Error("セッションIDの形式が正しくありません");
    const existing = this.deletionTasks.get(id);
    if (existing) return existing;
    if (this.closing) throw new Error("VC文字起こし機能を終了中です");
    const task = this.deleteSessionInternal(id, { reason });
    this.deletionTasks.set(id, task);
    try {
      return await task;
    } finally {
      if (this.deletionTasks.get(id) === task) this.deletionTasks.delete(id);
    }
  }

  async deleteSessionInternal(id, { reason = "deleted" } = {}) {
    const prepared = await this.runSessionOperation(async () => {
      const record = await this.archive.getSession(id);
      if (!record) return { missing: true };
      const claimed = await this.archive.transitionSession(id, [record.state], {
        state: "deleting",
        failureCode: null,
      });
      if (!claimed) throw new Error("セッション状態が変わったため削除をやり直してください");
      const activeSession = this.session?.id === id ? this.session : null;
      if (activeSession) {
        activeSession.state = "deleting";
        clearTimeout(this.maxTimer);
        clearInterval(this.noticeTimer);
        clearInterval(this.automaticValidationTimer);
        clearInterval(this.sessionWatchdogTimer);
        this.automaticValidationTimer = null;
        this.sessionWatchdogTimer = null;
        this.emptyVoiceSinceMs = null;
        this.connectionLostAtMs = null;
      }
      this.processingAbortControllers.get(id)?.abort(reason);
      return { activeSession, task: this.processing.get(id) || null };
    });
    if (prepared.missing) return false;
    if (prepared.activeSession) await this.receiver.stop({ discardActive: true });
    if (prepared.activeSession) {
      await this.runSessionOperation(async () => {
        if (this.session === prepared.activeSession) this.session = null;
      });
    }
    let taskOutcome = null;
    if (prepared.task) {
      taskOutcome = await prepared.task.catch((error) => ({
        ok: false,
        code: shortCode(error),
        cancellationFailed: true,
      }));
    }
    if (taskOutcome?.ok === false && taskOutcome.code !== "ABORTED") {
      const code = shortCode({ code: taskOutcome.code });
      await this.archive.updateSession(id, { state: "deletion_failed", failureCode: code }).catch(() => {});
      throw Object.assign(new Error("削除確認に失敗しました。管理者ログを確認してください"), { code });
    }
    await this.archive.deleteSession(id);
    return true;
  }

  async handleButton(interaction) {
    if (!interaction.isButton?.() || !interaction.customId.startsWith("voice:")) return false;
    const [, action, id] = interaction.customId.split(":");
    if (!this.session || this.session.id !== id) {
      await interaction.reply({ content: "このVC文字起こし操作は期限切れです。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    try {
      if (action === "consent") {
        const result = await this.consent(interaction);
        await interaction.reply({
          content: result.allConsented ? "全員の同意を確認し、録音を開始しました。" : `同意を記録しました（${result.consented}/${result.required}人）。`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      } else if (action === "decline") {
        await this.decline(interaction);
        await interaction.reply({ content: "同意しない回答を確認し、開始を取り消しました。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } else if (action === "withdraw") {
        await this.decline(interaction, { withdraw: true });
        await interaction.reply({ content: "同意を撤回し、録音を停止しました。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } else if (action === "stop") {
        const userId = String(interaction.user.id);
        if (!this.canManage(interaction) && !this.session.requiredUserIds.has(userId)) {
          throw new Error("現在のVC参加者または会議管理者だけが停止できます");
        }
        await this.stopSession({ reason: "manual", requestedById: userId });
        await interaction.reply({ content: "録音を停止し、文字起こしを開始しました。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      await interaction.reply({ content: safeDisplayText(error.message, 240), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    }
    return true;
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const task = this.closeInternal();
    this.closePromise = task;
    return task;
  }

  async closeInternal() {
    clearInterval(this.janitorTimer);
    clearTimeout(this.maxTimer);
    clearInterval(this.noticeTimer);
    clearInterval(this.automaticValidationTimer);
    clearInterval(this.sessionWatchdogTimer);
    this.automaticValidationTimer = null;
    this.sessionWatchdogTimer = null;
    this.emptyVoiceSinceMs = null;
    this.connectionLostAtMs = null;
    await this.operationTail.catch(() => {});
    await Promise.allSettled([...this.deletionTasks.values()]);
    if (this.session) {
      const session = this.session;
      await this.receiver.stop({ discardActive: false });
      await this.archive.updateSession(session.id, { state: "interrupted", stoppedAtMs: this.now() }).catch(() => {});
      this.session = null;
    }
    await Promise.allSettled([...this.processing.values()]);
    await this.archive.close?.();
    this.automaticPendingOutcomes.clear();
  }
}

export { CONSENT_POLICY_REVISION };
