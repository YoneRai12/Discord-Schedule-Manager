import crypto from "node:crypto";
import { buildMeetingPayload } from "./discord-ui.mjs";
import { directMessageErrorCode } from "./discord-direct-messenger.mjs";

const NON_RETRYABLE_CODES = new Set([
  "10003", // Unknown Channel
  "10008", // Unknown Message
  "50001", // Missing Access
  "50013", // Missing Permissions
  "channel_not_text",
  "channel_guild_mismatch",
  "message_id_missing",
]);

const RECREATABLE_STATUSES = new Set(["active", "completed", "cancelled"]);

function recreationNonce(claim) {
  return crypto
    .createHash("sha256")
    .update(`${String(claim.meetingId).toUpperCase()}:${Number(claim.targetCardRevision)}`)
    .digest("hex")
    .slice(0, 24);
}

function requireStore(store) {
  for (const method of [
    "claimMeetingCardUpdates",
    "isMeetingCardUpdateClaimCurrent",
    "getMeetingCardUpdateData",
    "markMeetingCardUpdateSucceeded",
    "markMeetingCardUpdateFailed",
    "queueMeetingCardUpdate",
    "adoptRecreatedMeetingCard",
    "getMeeting",
  ]) {
    if (typeof store?.[method] !== "function") throw new TypeError(`store.${method} is required`);
  }
  return store;
}

/**
 * Delivers only a durable reference to a meeting-card update.  The card body and
 * Discord identifiers are deliberately read from the current database state at
 * delivery time, never retained in the outbox row.
 */
export class MeetingCardUpdateScheduler {
  constructor({
    store,
    client,
    everyoneOffsets = [0],
    intervalSeconds = 15,
    leaseMs = 120_000,
    batchSize = 25,
    maxAttempts = 5,
    now = () => Date.now(),
    logger = console,
  }) {
    if (!client?.channels?.fetch) throw new TypeError("client.channels.fetch is required");
    this.store = requireStore(store);
    this.client = client;
    this.everyoneOffsets = everyoneOffsets;
    this.intervalMs = Math.max(1, Number(intervalSeconds)) * 1_000;
    this.leaseMs = Math.max(1_000, Number(leaseMs));
    this.batchSize = Math.max(1, Math.min(100, Number(batchSize)));
    this.maxAttempts = Math.max(1, Math.min(20, Number(maxAttempts)));
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.activeTick = null;
  }

  start() {
    if (this.timer) return false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    return true;
  }

  stop() {
    if (!this.timer) return false;
    clearInterval(this.timer);
    this.timer = null;
    return true;
  }

  async stopAndDrain(timeoutMs = 5_000) {
    this.stop();
    const active = this.activeTick;
    if (!active) return true;
    const timeout = Math.max(0, Number(timeoutMs) || 0);
    if (timeout === 0) return false;
    let timer;
    try {
      return await Promise.race([
        active.then(() => true, () => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeout); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async tick() {
    if (this.running) {
      return { claimed: 0, updated: 0, failed: 0, skipped: 0, stale: 0, busy: true };
    }
    this.running = true;
    const result = { claimed: 0, updated: 0, failed: 0, skipped: 0, stale: 0, busy: false };
    const execution = (async () => {
      const claims = this.store.claimMeetingCardUpdates({
        nowMs: Number(this.now()),
        leaseMs: this.leaseMs,
        limit: this.batchSize,
      });
      result.claimed = claims.length;
      for (const claim of claims) result[await this.deliver(claim)] += 1;
    })();
    this.activeTick = execution;
    try {
      await execution;
    } catch (error) {
      result.failed += 1;
      this.logger.error?.(`[meeting-card-update] tick_failed code=${directMessageErrorCode(error)}`);
    } finally {
      if (this.activeTick === execution) this.activeTick = null;
      this.running = false;
    }
    return result;
  }

  async deliver(claim) {
    if (!this.store.isMeetingCardUpdateClaimCurrent(claim)) return "stale";
    const card = this.store.getMeetingCardUpdateData(claim);
    if (!card?.meeting?.messageId) return "stale";
    try {
      const channel = await this.client.channels.fetch(card.meeting.channelId);
      if (!channel?.isTextBased?.()) {
        throw Object.assign(new Error("Meeting card channel is not text based"), { code: "channel_not_text" });
      }
      const message = await channel.messages.fetch(card.meeting.messageId);
      const payload = buildMeetingPayload(card.meeting, card.rsvps, {
        everyoneOffsets: this.everyoneOffsets,
        invitees: card.invitees,
      });
      if (!this.store.isMeetingCardUpdateClaimCurrent(claim)) return "stale";
      await message.edit(payload);
      if (!this.store.markMeetingCardUpdateSucceeded(claim)) {
        this.logger.warn?.("[meeting-card-update] receipt_stale");
        try {
          // Discord may have accepted this stale edit after a newer generation was
          // already delivered and removed from the outbox. Requeue the current
          // generation so the next tick repairs the externally visible card.
          this.store.queueMeetingCardUpdate(claim.meetingId, { nowMs: Number(this.now()) });
        } catch (error) {
          this.logger.warn?.(
            `[meeting-card-update] repair_enqueue_failed code=${directMessageErrorCode(error)}`,
          );
        }
        return "stale";
      }
      return "updated";
    } catch (error) {
      if (directMessageErrorCode(error) === "10008") return this.recreateMissingCard(claim);
      return this.recordFailure(claim, error);
    }
  }

  recordFailure(claim, error) {
    const code = directMessageErrorCode(error);
    const retryable = !NON_RETRYABLE_CODES.has(code);
    const persisted = this.store.markMeetingCardUpdateFailed(claim, {
      errorCode: code,
      retryable,
      maxAttempts: this.maxAttempts,
      failedAtMs: Number(this.now()),
    });
    if (!persisted) return "stale";
    this.logger.warn?.(`[meeting-card-update] delivery_failed code=${code}`);
    return retryable && Number(claim.attempts) < this.maxAttempts ? "failed" : "skipped";
  }

  requeueLatest(meetingId) {
    try {
      this.store.queueMeetingCardUpdate(meetingId, { nowMs: Number(this.now()) });
    } catch (error) {
      this.logger.warn?.(
        `[meeting-card-update] repair_enqueue_failed code=${directMessageErrorCode(error)}`,
      );
    }
  }

  async discardStaleRecreation(claim, message) {
    if (typeof message?.delete !== "function") return;
    try {
      const current = this.store.getMeeting(claim.meetingId);
      // A reclaimed lease for the same revision uses the same nonce and may
      // receive the exact message already adopted by the newer worker. Never
      // delete in that generation; only a superseded generation is disposable.
      if (!current || current.cardRevision === Number(claim.targetCardRevision)) return;
      if (String(current.messageId ?? "") === String(message.id)) return;
    } catch (error) {
      this.logger.warn?.(
        `[meeting-card-update] stale_recreation_check_failed code=${directMessageErrorCode(error)}`,
      );
      return;
    }
    try {
      await message.delete();
    } catch (error) {
      const code = directMessageErrorCode(error);
      if (code !== "10008") {
        this.logger.warn?.(`[meeting-card-update] stale_recreation_delete_failed code=${code}`);
      }
    }
  }

  async recreateMissingCard(claim) {
    let createdMessage = null;
    try {
      // Re-read after the 10008. A newer generation may have replaced this claim
      // while the failed Discord request was in flight.
      if (!this.store.isMeetingCardUpdateClaimCurrent(claim)) return "stale";
      const latest = this.store.getMeetingCardUpdateData(claim);
      if (!latest?.meeting?.messageId || !RECREATABLE_STATUSES.has(latest.meeting.status)) {
        return "stale";
      }
      const channel = await this.client.channels.fetch(latest.meeting.channelId);
      if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
        throw Object.assign(new Error("Meeting card channel is not text based"), {
          code: "channel_not_text",
        });
      }
      if (channel.guildId != null && String(channel.guildId) !== String(latest.meeting.guildId)) {
        throw Object.assign(new Error("Meeting card channel belongs to another guild"), {
          code: "channel_guild_mismatch",
        });
      }
      const payload = buildMeetingPayload(latest.meeting, latest.rsvps, {
        everyoneOffsets: this.everyoneOffsets,
        invitees: latest.invitees,
      });
      if (!this.store.isMeetingCardUpdateClaimCurrent(claim)) return "stale";
      createdMessage = await channel.send({
        ...payload,
        nonce: recreationNonce(claim),
        enforceNonce: true,
      });
      if (!createdMessage?.id) {
        throw Object.assign(new Error("Recreated meeting card has no message id"), {
          code: "message_id_missing",
        });
      }
      const adopted = this.store.adoptRecreatedMeetingCard(claim, {
        expectedMessageId: latest.meeting.messageId,
        newMessageId: createdMessage.id,
      });
      if (adopted) return "updated";

      this.logger.warn?.("[meeting-card-update] recreation_receipt_stale");
      await this.discardStaleRecreation(claim, createdMessage);
      this.requeueLatest(claim.meetingId);
      return "stale";
    } catch (error) {
      // A created-but-uncommitted card must never be allowed to become the
      // canonical card after this claim has failed.
      if (createdMessage) await this.discardStaleRecreation(claim, createdMessage);
      return this.recordFailure(claim, error);
    }
  }
}

export const meetingCardUpdateNonRetryableCodes = NON_RETRYABLE_CODES;
