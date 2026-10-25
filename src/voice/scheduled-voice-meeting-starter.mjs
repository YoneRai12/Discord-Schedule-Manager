import crypto from "node:crypto";
import { ChannelType } from "discord.js";

function shortCode(error) {
  return String(error?.code || error?.status || error?.name || "voice_auto_error").slice(0, 80);
}

function humanMembers(channel) {
  return [...(channel?.members?.values?.() || [])]
    .filter((member) => !member?.user?.bot)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Starts only the consent flow for scheduled Discord VC meetings. Audio starts after unanimous consent. */
export class ScheduledVoiceMeetingStarter {
  constructor({
    client,
    store,
    controller,
    guildId,
    earlyMinutes = 15,
    intervalSeconds = 30,
    archive = controller?.archive ?? null,
    logger = console,
    now = () => Date.now(),
  } = {}) {
    this.client = client;
    this.store = store;
    this.controller = controller;
    this.guildId = String(guildId || "");
    this.earlyMinutes = Math.max(0, Math.min(120, Number(earlyMinutes) || 15));
    this.intervalSeconds = Math.max(10, Math.min(120, Number(intervalSeconds) || 30));
    this.archive = archive;
    this.logger = logger;
    this.now = now;
    this.timer = null;
    this.running = null;
    this.failureCooldowns = new Map();
  }

  async start() {
    if (this.timer) return false;
    this.store.recoverStaleVoiceAutoClaims?.({ nowMs: this.now() });
    await this.recoverInterruptedAutomaticSessions();
    this.timer = setInterval(() => void this.tick(), this.intervalSeconds * 1_000);
    this.timer.unref?.();
    await this.tick();
    return true;
  }

  async recoverInterruptedAutomaticSessions() {
    if (!this.archive?.getSession || !this.store.listFinalizedVoiceAutoStarts) return 0;
    const meetings = this.store.listFinalizedVoiceAutoStarts(this.guildId, { limit: 100 });
    let recovered = 0;
    for (const meeting of meetings) {
      try {
        const archived = await this.archive.getSession(meeting.voiceAutoSessionId);
        if (!archived || !["pending_consent", "recording", "paused_for_consent", "interrupted"].includes(archived.state)) {
          continue;
        }
        await this.archive.updateSession(meeting.voiceAutoSessionId, {
          state: "interrupted",
          stoppedAtMs: this.now(),
          stopReason: "process_restarted",
          failureCode: "process_restarted",
        });
        if (this.store.releaseVoiceAutoStart(meeting.id, meeting.voiceAutoSessionId, {
          expectedVoiceChannelId: meeting.voiceChannelId,
        })) {
          recovered += 1;
        }
      } catch (error) {
        this.logger.warn?.(`[voice-auto] recovery_failed code=${shortCode(error)}`);
      }
    }
    return recovered;
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const user = newState?.member?.user || oldState?.member?.user;
    const joined = String(newState?.channelId || "") !== ""
      && String(newState?.channelId || "") !== String(oldState?.channelId || "");
    if (!joined || !user || user.bot || String(newState?.guild?.id || "") !== this.guildId) return false;
    return this.tick({ channelId: String(newState.channelId) });
  }

  async tick({ channelId = null } = {}) {
    if (this.running) return this.running;
    this.running = this.tickInternal({ channelId }).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async tickInternal({ channelId = null } = {}) {
    if (this.controller?.session?.automatic && this.controller.validateAutomaticPendingNow) {
      await this.controller.validateAutomaticPendingNow();
    }
    if (!this.controller?.enabled || this.controller.session || this.controller.starting || this.controller.processing?.size) {
      return false;
    }
    const nowMs = this.now();
    const candidates = this.store.listVoiceAutoStartCandidates(this.guildId, {
      nowMs,
      earlyMinutes: this.earlyMinutes,
      limit: 50,
    }).filter((meeting) => !channelId || meeting.voiceChannelId === String(channelId));
    if (!candidates.length) return false;

    const byChannel = new Map();
    for (const meeting of candidates) {
      const list = byChannel.get(meeting.voiceChannelId) || [];
      list.push(meeting);
      byChannel.set(meeting.voiceChannelId, list);
    }

    const guild = await this.client.guilds.fetch(this.guildId);
    for (const [voiceChannelId, meetings] of byChannel) {
      if (meetings.length !== 1) {
        this.logger.warn?.(`[voice-auto] overlapping_meetings channel=redacted count=${meetings.length}`);
        continue;
      }
      const meeting = meetings[0];
      if ((this.failureCooldowns.get(meeting.id) || 0) > nowMs) continue;
      const voiceChannel = await guild.channels.fetch(voiceChannelId).catch(() => null);
      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice || !humanMembers(voiceChannel).length) continue;
      const started = await this.startMeeting({ guild, voiceChannel, meeting, nowMs });
      if (started) return true;
    }
    return false;
  }

  async startMeeting({ guild, voiceChannel, meeting, nowMs }) {
    const claimToken = crypto.randomBytes(12).toString("base64url");
    if (!this.store.claimVoiceAutoStart(meeting.id, claimToken, {
      nowMs,
      earlyMinutes: this.earlyMinutes,
      expectedUpdatedAtMs: meeting.updatedAtMs,
      expectedVoiceChannelId: meeting.voiceChannelId,
    })) return false;
    let createdSessionId = null;
    let finalized = false;
    try {
      const members = humanMembers(voiceChannel);
      if (!members.length) throw new Error("voice_empty");
      const result = await this.controller.requestStartForVoiceChannel({
        guild,
        voiceChannel,
        requestedById: members[0].id,
        title: meeting.title,
        automatic: true,
        sourceMeetingId: meeting.id,
      });
      createdSessionId = result.sessionId;
      if (!this.store.finalizeVoiceAutoStart(meeting.id, claimToken, createdSessionId, { nowMs: this.now() })) {
        this.logger.error?.("[voice-auto] claim_finalize_failed");
        await this.controller.cancelAutomaticPending?.({
          expectedSessionId: createdSessionId,
          reason: "claim_finalize_failed",
          retryable: true,
        });
        this.store.releaseVoiceAutoStart(meeting.id, claimToken, {
          expectedVoiceChannelId: meeting.voiceChannelId,
        });
        this.failureCooldowns.set(meeting.id, this.now() + 30_000);
        return false;
      }
      finalized = true;
      if (await this.controller.confirmAutomaticPending?.(createdSessionId) !== true) {
        throw Object.assign(new Error("automatic_pending_confirm_failed"), {
          code: "automatic_pending_confirm_failed",
        });
      }
      return true;
    } catch (error) {
      let pendingOutcome = null;
      if (finalized && createdSessionId && this.controller.consumeAutomaticPendingOutcome) {
        try {
          pendingOutcome = await this.controller.consumeAutomaticPendingOutcome(createdSessionId);
        } catch (outcomeError) {
          pendingOutcome = { retryable: false, reason: "outcome_lookup_failed" };
          this.logger.warn?.(`[voice-auto] outcome_lookup_failed code=${shortCode(outcomeError)}`);
        }
      }
      const nonRetryable = pendingOutcome?.retryable === false;
      if (createdSessionId && !nonRetryable) {
        await this.controller.cancelAutomaticPending?.({
          expectedSessionId: createdSessionId,
          reason: "automatic_start_failed",
          retryable: true,
        }).catch(() => {});
      }
      if (!nonRetryable) {
        this.store.releaseVoiceAutoStart(meeting.id, finalized ? createdSessionId : claimToken, {
          expectedVoiceChannelId: meeting.voiceChannelId,
        });
      }
      this.failureCooldowns.set(meeting.id, this.now() + 30_000);
      this.logger.warn?.(`[voice-auto] start_failed code=${shortCode(error)}`);
      return false;
    }
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    this.failureCooldowns.clear();
  }
}
