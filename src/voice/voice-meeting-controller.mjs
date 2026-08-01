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
const ACTIVE_STATES = new Set(["pending_consent", "recording", "paused_for_consent", "stopping", "processing"]);

function shortCode(error) {
  return String(error?.code || error?.status || error?.name || "voice_error").slice(0, 80);
}

function sessionId() {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

function humanMembers(channel) {
  return [...(channel?.members?.values?.() || [])]
    .filter((member) => !member?.user?.bot)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function buttonRows(id, { active = false } = {}) {
  if (active) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`voice:stop:${id}`)
        .setLabel("録音を停止")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`voice:withdraw:${id}`)
        .setLabel("同意を撤回して停止")
        .setStyle(ButtonStyle.Secondary),
    )];
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

function consentNotice({ id, title, required, consented, summaryEnabled, factCheckEnabled, paused = false }) {
  return {
    content: [
      paused ? "⏸️ **新しい参加者の同意待ちのため録音を一時停止しています**" : "🎙️ **VC文字起こしの同意確認**",
      `セッション: **${safeDisplayText(id, 16)}** / ${safeDisplayText(title || "VCミーティング", 100)}`,
      `同意: **${consented}/${required}人**`,
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
    this.logger = logger;
    this.now = now;
    this.session = null;
    this.processing = new Map();
    this.maxTimer = null;
    this.noticeTimer = null;
    this.janitorTimer = null;
  }

  async initialize() {
    if (!this.enabled) return { enabled: false };
    await this.archive.initialize?.();
    const purge = await this.archive.purgeExpired?.({ nowMs: this.now() });
    if (purge?.failed) {
      throw Object.assign(new Error("期限切れ音声データを削除できないためVC録音を開始できません"), { code: "voice_purge_failed" });
    }
    this.janitorTimer = setInterval(() => {
      void this.archive.purgeExpired?.({ nowMs: this.now() }).catch((error) => {
        this.logger.warn?.(`[voice] retention_purge_failed code=${shortCode(error)}`);
      });
    }, 15 * 60_000);
    this.janitorTimer.unref?.();
    return { enabled: true };
  }

  privacyText() {
    return [
      "**VC文字起こしのプライバシー**",
      "- 管理者が手動で開始し、VC内の全員が毎回同意するまで録音しません。",
      "- 新しい参加者が入ると全録音を停止し、その人の同意後に再開します。",
      "- 音声はこのPCだけで文字起こしし、外部STT APIへ送りません。",
      "- ローカル音声・文字起こしは開始から24時間で削除します。管理者は早期削除もできます。",
      "- 音声はDiscordへ送信しません。文字起こし・要約は権限制限された専用チャンネルへ投稿され、Discord側では24時間後も残ります。",
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
      `同意: **${this.session.consentedUserIds.size}/${this.session.requiredUserIds.size}人**`,
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
    const everyoneOverwrite = channel.permissionOverwrites?.cache?.get?.(guild.roles.everyone.id);
    if (!everyoneOverwrite?.deny?.has?.(PermissionFlagsBits.ViewChannel)) {
      throw new Error("議事録チャンネルは @everyone のチャンネル表示を明示的に拒否してください");
    }
    const invisible = members.filter((member) => !channel.permissionsFor(member)?.has?.(PermissionFlagsBits.ViewChannel));
    if (invisible.length) throw new Error("VC参加者全員が議事録チャンネルを見られるようにしてください");
    return channel;
  }

  async requestStart(subject, { title = "VCミーティング" } = {}) {
    if (!this.enabled) throw new Error("VC文字起こし機能は設定されていません");
    if (this.session && ACTIVE_STATES.has(this.session.state)) throw new Error("すでにVC文字起こしセッションが動作中です");
    if (this.processing.size) throw new Error("前のVC文字起こしを処理中です。完了後に開始してください");
    const guild = await this.client.guilds.fetch(this.guildId);
    const actorId = String(subject?.user?.id || subject?.author?.id || "");
    const actor = await guild.members.fetch(actorId);
    const voiceChannel = actor.voice?.channel;
    if (!voiceChannel || voiceChannel.guildId !== guild.id || voiceChannel.type === ChannelType.GuildStageVoice) {
      throw new Error("開始する本人が通常のDiscord VCへ入ってから実行してください");
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
    const record = await this.archive.createSession({
      sessionId: id,
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      outputChannelId: outputChannel.id,
      requestedById: actor.id,
      title: safeDisplayText(title, 100) || "VCミーティング",
      state: "pending_consent",
      policyRevision: CONSENT_POLICY_REVISION,
      createdAtMs,
      expiresAtMs,
      requiredUserIds: [...requiredUserIds],
      consentedUserIds: [],
    });
    const notice = await outputChannel.send(consentNotice({
      id,
      title: record.title || title,
      required: requiredUserIds.size,
      consented: 0,
      summaryEnabled: this.summaryEnabled,
      factCheckEnabled: this.factCheckEnabled,
    }));
    this.session = {
      id,
      guild,
      voiceChannel,
      outputChannel,
      noticeMessageId: notice.id,
      requestedById: actor.id,
      title: record.title || safeDisplayText(title, 100),
      state: "pending_consent",
      createdAtMs,
      expiresAtMs,
      requiredUserIds,
      consentedUserIds: new Set(),
    };
    await this.archive.updateSession(id, { noticeMessageId: notice.id });
    return { sessionId: id, required: requiredUserIds.size, outputChannelId: outputChannel.id };
  }

  async updateConsentNotice({ paused = false } = {}) {
    const session = this.session;
    if (!session) return;
    try {
      const notice = await session.outputChannel.messages.fetch(session.noticeMessageId);
      await notice.edit(consentNotice({
        id: session.id,
        title: session.title,
        required: session.requiredUserIds.size,
        consented: [...session.requiredUserIds].filter((id) => session.consentedUserIds.has(id)).length,
        summaryEnabled: this.summaryEnabled,
        factCheckEnabled: this.factCheckEnabled,
        paused,
      }));
    } catch (error) {
      this.logger.warn?.(`[voice] consent_notice_update_failed code=${shortCode(error)}`);
    }
  }

  async consent(subject) {
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
    const stored = await this.archive.getSession(session.id);
    await this.archive.updateSession(session.id, {
      state: session.state,
      requiredUserIds: [...session.requiredUserIds],
      consentedUserIds: [...session.consentedUserIds],
      consents: [
        ...(stored?.consents || []),
        { userId, decision: "allow", decidedAtMs: this.now(), policyRevision: CONSENT_POLICY_REVISION },
      ],
    });
    const allConsented = [...session.requiredUserIds].every((id) => session.consentedUserIds.has(id));
    if (allConsented) {
      if (session.state === "pending_consent") await this.beginRecording();
      else await this.resumeRecording();
    } else {
      await this.updateConsentNotice({ paused: session.state === "paused_for_consent" });
    }
    return { allConsented, consented: session.consentedUserIds.size, required: session.requiredUserIds.size };
  }

  async decline(subject, { withdraw = false } = {}) {
    const session = this.session;
    if (!session) throw new Error("対象のVC文字起こしセッションがありません");
    const userId = String(subject.user?.id || subject.author?.id || "");
    if (!session.requiredUserIds.has(userId)) throw new Error("対象VCの参加者だけが操作できます");
    const stored = await this.archive.getSession(session.id);
    await this.archive.updateSession(session.id, {
      consents: [
        ...(stored?.consents || []),
        { userId, decision: withdraw ? "withdraw" : "deny", decidedAtMs: this.now(), policyRevision: CONSENT_POLICY_REVISION },
      ],
    });
    if (session.state === "pending_consent") {
      await this.cancelPending("参加者が同意しなかったため開始を取り消しました");
      return { cancelled: true };
    }
    await this.stopSession({ reason: "consent_withdrawn", requestedById: userId });
    return { stopped: true };
  }

  async beginRecording() {
    const session = this.session;
    if (!session || session.state !== "pending_consent") return false;
    const currentMembers = humanMembers(session.voiceChannel);
    const currentIds = new Set(currentMembers.map((member) => String(member.id)));
    session.requiredUserIds = currentIds;
    const allConsented = [...currentIds].every((id) => session.consentedUserIds.has(id));
    if (!allConsented) {
      await this.updateConsentNotice();
      return false;
    }
    await this.receiver.start({
      guild: session.guild,
      voiceChannelId: session.voiceChannel.id,
      sessionId: session.id,
      consentedUserIds: session.consentedUserIds,
    });
    session.state = "recording";
    await this.archive.updateSession(session.id, { state: "recording", startedAtMs: this.now() });
    const notice = await session.outputChannel.messages.fetch(session.noticeMessageId);
    await notice.edit({
      content: [
        "🔴 **VC文字起こし中**",
        `セッション: **${safeDisplayText(session.id, 16)}** / ${safeDisplayText(session.title, 100)}`,
        "全参加者が同意しました。音声はローカル処理され、開始から24時間以内に削除されます。",
        "誰でも下のボタンから直ちに停止できます。",
      ].join("\n"),
      components: buttonRows(session.id, { active: true }),
      allowedMentions: { parse: [] },
    });
    this.maxTimer = setTimeout(() => {
      void this.stopSession({ reason: "max_duration", requestedById: "system" });
    }, this.maxSessionMinutes * 60_000);
    this.maxTimer.unref?.();
    this.noticeTimer = setInterval(() => {
      void session.outputChannel.send({
        content: `🔴 VC文字起こし継続中 — セッション **${safeDisplayText(session.id, 16)}**`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }, this.noticeIntervalMinutes * 60_000);
    this.noticeTimer.unref?.();
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
      components: buttonRows(session.id, { active: true }),
      allowedMentions: { parse: [] },
    });
    return true;
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const session = this.session;
    if (!session || !["recording", "paused_for_consent"].includes(session.state)) return false;
    const user = newState?.member?.user || oldState?.member?.user;
    if (!user || user.bot || String(newState.guild?.id || oldState.guild?.id || "") !== this.guildId) return false;
    const userId = String(user.id);
    const joined = String(newState.channelId || "") === String(session.voiceChannel.id)
      && String(oldState.channelId || "") !== String(session.voiceChannel.id);
    const left = String(oldState.channelId || "") === String(session.voiceChannel.id)
      && String(newState.channelId || "") !== String(session.voiceChannel.id);
    if (joined && !session.consentedUserIds.has(userId)) {
      await this.pauseForConsent(userId);
      return true;
    }
    if (left) {
      session.requiredUserIds.delete(userId);
      const remaining = humanMembers(session.voiceChannel);
      if (!remaining.length) {
        await this.stopSession({ reason: "voice_empty", requestedById: "system" });
        return true;
      }
      if (session.state === "paused_for_consent"
          && [...session.requiredUserIds].every((id) => session.consentedUserIds.has(id))) {
        await this.resumeRecording();
      } else {
        await this.updateConsentNotice({ paused: session.state === "paused_for_consent" });
      }
      return true;
    }
    return false;
  }

  async cancelPending(reason) {
    const session = this.session;
    if (!session) return;
    clearTimeout(this.maxTimer);
    clearInterval(this.noticeTimer);
    try {
      const notice = await session.outputChannel.messages.fetch(session.noticeMessageId);
      await notice.edit({ content: safeDisplayText(reason, 300), components: [], allowedMentions: { parse: [] } });
    } catch {}
    await this.archive.deleteSession(session.id);
    this.session = null;
  }

  async stopSession({ reason = "manual", requestedById = "system" } = {}) {
    const session = this.session;
    if (!session) return { stopped: false };
    if (["stopping", "processing"].includes(session.state)) return { stopped: true, processing: true };
    clearTimeout(this.maxTimer);
    clearInterval(this.noticeTimer);
    session.state = "stopping";
    await this.archive.updateSession(session.id, { state: "stopping", stopReason: reason, stoppedById: requestedById });
    await this.receiver.stop();
    session.state = "processing";
    await this.archive.updateSession(session.id, { state: "processing", stoppedAtMs: this.now() });
    await session.outputChannel.send({
      content: `⏳ セッション **${safeDisplayText(session.id, 16)}** のローカル文字起こしと議事録を処理しています。`,
      allowedMentions: { parse: [] },
    });
    const processPromise = this.processSession(session);
    this.processing.set(session.id, processPromise);
    this.session = null;
    processPromise.finally(() => this.processing.delete(session.id));
    return { stopped: true, processing: true, sessionId: session.id };
  }

  async processSession(session) {
    try {
      const transcript = await this.transcriber.transcribeSession(session.id);
      await this.archive.writeTranscript(session.id, transcript);
      const analysis = this.analyzer
        ? await this.analyzer.analyze(transcript, { knownNames: transcript.segments?.map((item) => item.speakerName) || [] })
        : { aiUsed: false, factCheckUsed: false, minutes: null, factChecks: [] };
      await this.archive.writeAnalysis?.(session.id, analysis);
      if (this.publisher) {
        await this.publisher.publish({
          session: { ...session, state: "review_pending" },
          transcript,
          analysis,
        });
      }
      await this.archive.updateSession(session.id, { state: "review_pending", completedAtMs: this.now() });
      return { ok: true };
    } catch (error) {
      await this.archive.updateSession(session.id, { state: "processing_failed", failureCode: shortCode(error) }).catch(() => {});
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

  async reprocess(sessionIdValue) {
    const id = String(sessionIdValue || "").trim().toUpperCase();
    if (!/^[A-F0-9]{10}$/u.test(id)) throw new Error("セッションIDの形式が正しくありません");
    if (this.processing.has(id)) throw new Error("このセッションはすでに処理中です");
    const record = await this.archive.getSession(id);
    if (!record || record.guildId !== this.guildId || record.expiresAtMs <= this.now()) {
      throw new Error("再処理できるローカル音声が見つかりません");
    }
    const guild = await this.client.guilds.fetch(this.guildId);
    const outputChannel = await guild.channels.fetch(record.outputChannelId);
    const session = { ...record, guild, outputChannel, id };
    const task = this.processSession(session);
    this.processing.set(id, task);
    task.finally(() => this.processing.delete(id));
    return { sessionId: id, processing: true };
  }

  async deleteSession(sessionIdValue) {
    const id = String(sessionIdValue || "").trim().toUpperCase();
    if (!/^[A-F0-9]{10}$/u.test(id)) throw new Error("セッションIDの形式が正しくありません");
    if (this.session?.id === id) await this.stopSession({ reason: "deleted", requestedById: "manager" });
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
    clearInterval(this.janitorTimer);
    clearTimeout(this.maxTimer);
    clearInterval(this.noticeTimer);
    if (this.session) {
      const session = this.session;
      await this.receiver.stop({ discardActive: false });
      await this.archive.updateSession(session.id, { state: "interrupted", stoppedAtMs: this.now() }).catch(() => {});
      this.session = null;
    }
    await Promise.allSettled([...this.processing.values()]);
    await this.archive.close?.();
  }
}

export { CONSENT_POLICY_REVISION };
