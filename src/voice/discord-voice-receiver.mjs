import { getCiphers } from "node:crypto";
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import prism from "prism-media";
import { WavSegmentWriter } from "./wav-segment-writer.mjs";

function errorCode(error) {
  return String(error?.code || error?.name || "voice_receive_error").slice(0, 80);
}

function humanDisplayName(member) {
  return String(member?.displayName || member?.user?.globalName || member?.user?.username || "参加者")
    .replace(/@everyone|@here/giu, (value) => value.replace("@", "＠"))
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

export class DiscordVoiceReceiver {
  constructor({
    archive,
    silenceMs = 1_000,
    maxSegmentMs = 60_000,
    readyTimeoutMs = 20_000,
    logger = console,
    voice = { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel },
    prismModule = prism,
    writerFactory = (options) => new WavSegmentWriter(options),
  } = {}) {
    if (!archive) throw new TypeError("voice archive is required");
    this.archive = archive;
    this.silenceMs = Math.max(500, Math.min(5_000, Number(silenceMs) || 1_000));
    this.maxSegmentMs = Math.max(5_000, Math.min(60_000, Number(maxSegmentMs) || 60_000));
    this.readyTimeoutMs = Math.max(5_000, Math.min(60_000, Number(readyTimeoutMs) || 20_000));
    this.logger = logger;
    this.voice = voice;
    this.prism = prismModule;
    this.writerFactory = writerFactory;
    this.connection = null;
    this.guild = null;
    this.voiceChannelId = null;
    this.sessionId = null;
    this.paused = true;
    this.consentedUserIds = new Set();
    this.active = new Map();
    this.finalizations = new Set();
    this.speakingListener = null;
  }

  get activeSessionId() {
    return this.sessionId;
  }

  isConnected({ guildId = null, voiceChannelId = null, sessionId = null } = {}) {
    if (!this.connection || !this.sessionId) return false;
    if (this.connection.state?.status !== this.voice.VoiceConnectionStatus.Ready) return false;
    if (guildId != null && String(this.guild?.id || "") !== String(guildId)) return false;
    if (voiceChannelId != null && String(this.voiceChannelId || "") !== String(voiceChannelId)) return false;
    if (sessionId != null && String(this.sessionId || "") !== String(sessionId)) return false;
    return true;
  }

  async start({ guild, voiceChannelId, sessionId, consentedUserIds = [] }) {
    if (this.connection || this.sessionId) throw new Error("別のVC録音セッションが動作中です");
    if (!guild?.voiceAdapterCreator || !guild?.id) throw new Error("VCへ接続できるDiscordサーバー情報がありません");
    if (!getCiphers().includes("aes-256-gcm")) {
      throw new Error("このNode.jsはDiscord音声暗号に必要なAES-256-GCMを利用できません");
    }
    this.guild = guild;
    this.voiceChannelId = String(voiceChannelId);
    this.sessionId = String(sessionId);
    this.consentedUserIds = new Set([...consentedUserIds].map(String));
    this.paused = true;
    try {
      const connection = this.voice.joinVoiceChannel({
        channelId: this.voiceChannelId,
        guildId: String(guild.id),
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      this.connection = connection;
      await this.voice.entersState(connection, this.voice.VoiceConnectionStatus.Ready, this.readyTimeoutMs);
      this.speakingListener = (userId) => {
        void this.handleSpeakingStart(String(userId));
      };
      connection.receiver.speaking.on("start", this.speakingListener);
      this.paused = false;
      return true;
    } catch (error) {
      await this.stop({ discardActive: true });
      throw Object.assign(new Error("VCの受信接続を開始できませんでした"), { code: errorCode(error) });
    }
  }

  setConsentedUserIds(userIds) {
    this.consentedUserIds = new Set([...userIds].map(String));
  }

  async pause() {
    this.paused = true;
    await this.finishAllActive({ discard: false });
  }

  resume() {
    if (!this.connection || !this.sessionId) return false;
    this.paused = false;
    return true;
  }

  async handleSpeakingStart(userId) {
    if (this.paused || !this.connection || !this.sessionId) return false;
    if (!this.consentedUserIds.has(userId) || this.active.has(userId)) return false;
    let member;
    try {
      member = await this.guild.members.fetch(userId);
    } catch {
      return false;
    }
    if (member?.user?.bot || String(member?.voice?.channelId || "") !== this.voiceChannelId) return false;

    let segment;
    try {
      segment = await this.archive.createSegment(this.sessionId, {
        speakerId: userId,
        speakerName: humanDisplayName(member),
        startedAtMs: Date.now(),
      });
    } catch (error) {
      this.logger.warn?.(`[voice] segment_create_failed code=${errorCode(error)}`);
      return false;
    }

    const writer = this.writerFactory({
      filePath: segment.tempPath,
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
    });
    const opusStream = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: this.voice.EndBehaviorType.AfterSilence,
        duration: this.silenceMs,
      },
    });
    const decoder = new this.prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const state = {
      userId,
      segmentId: segment.segmentId,
      writer,
      opusStream,
      decoder,
      settled: false,
      timer: null,
    };
    this.active.set(userId, state);

    const settle = (discard = false) => this.finishSegment(state, { discard });
    state.timer = setTimeout(() => opusStream.destroy(), this.maxSegmentMs);
    state.timer.unref?.();
    decoder.on("data", (chunk) => {
      try {
        writer.write(chunk);
      } catch {
        void settle(true);
      }
    });
    decoder.once("end", () => void settle(false));
    decoder.once("close", () => void settle(false));
    decoder.once("error", () => void settle(true));
    opusStream.once("error", () => void settle(true));
    opusStream.once("close", () => {
      if (!decoder.destroyed) decoder.end();
    });
    opusStream.pipe(decoder);
    return true;
  }

  finishSegment(state, { discard = false } = {}) {
    if (!state || state.settled) return Promise.resolve(false);
    state.settled = true;
    clearTimeout(state.timer);
    this.active.delete(state.userId);
    try {
      state.opusStream.unpipe(state.decoder);
      state.opusStream.destroy();
      state.decoder.destroy();
    } catch {}
    const task = (async () => {
      try {
        if (discard) {
          await state.writer.abort?.();
          await this.archive.discardSegment(this.sessionId, state.segmentId);
          return false;
        }
        await state.writer.end();
        await this.archive.finalizeSegment(this.sessionId, state.segmentId, { endedAtMs: Date.now() });
        return true;
      } catch (error) {
        await state.writer.abort?.().catch?.(() => {});
        await this.archive.discardSegment(this.sessionId, state.segmentId).catch?.(() => {});
        this.logger.warn?.(`[voice] segment_finalize_failed code=${errorCode(error)}`);
        return false;
      }
    })();
    this.finalizations.add(task);
    task.finally(() => this.finalizations.delete(task));
    return task;
  }

  async finishAllActive({ discard = false } = {}) {
    await Promise.all([...this.active.values()].map((state) => this.finishSegment(state, { discard })));
    await Promise.allSettled([...this.finalizations]);
  }

  async stop({ discardActive = false } = {}) {
    this.paused = true;
    const connection = this.connection;
    if (connection && this.speakingListener) {
      connection.receiver?.speaking?.off?.("start", this.speakingListener);
    }
    await this.finishAllActive({ discard: discardActive });
    try {
      connection?.destroy?.();
    } catch {}
    this.connection = null;
    this.guild = null;
    this.voiceChannelId = null;
    this.sessionId = null;
    this.consentedUserIds.clear();
    this.speakingListener = null;
  }
}
