import { directMessageErrorCode } from "./discord-direct-messenger.mjs";

const NON_RETRYABLE_CODES = new Set([
  "10007", // Unknown Member
  "10003", // Unknown Channel
  "10008", // Unknown Message
  "10013", // Unknown User
  "50007", // Cannot send messages to this user
  "guild_mismatch",
  "not_guild_member",
  "not_human_member",
  "not_human_user",
  "recipient_missing",
  "message_id_missing",
  "user_fetch_unavailable",
  "invalid_dm_payload",
  "meeting_id_missing",
  "bot_identity_missing",
  "corrupt_reminder_json",
]);
const DEPARTED_MEMBER_CODES = new Set(["10007", "not_guild_member"]);
const ALREADY_GONE_DELETE_CODES = new Set(["10008", "10013"]);

function requireStore(store) {
  for (const method of [
    "claimDirectInviteUpdates",
    "isDirectInviteUpdateClaimCurrent",
    "markDirectInviteUpdateSucceeded",
    "markDirectInviteUpdateFailed",
    "claimDirectInviteSends",
    "isDirectInviteSendClaimCurrent",
    "getDirectInviteSendData",
    "markDirectInviteSendSucceeded",
    "markDirectInviteSendFailed",
    "closeDirectInviteSendForInactive",
    "reconcileDirectInviteSendStaleReceipt",
  ]) {
    if (typeof store?.[method] !== "function") throw new TypeError(`store.${method} is required`);
  }
  return store;
}

export class DirectInviteUpdateScheduler {
  constructor({
    store,
    directMessenger,
    intervalSeconds = 15,
    leaseMs = 120_000,
    batchSize = 25,
    maxAttempts = 5,
    now = () => Date.now(),
    logger = console,
  }) {
    if (!directMessenger?.updateMeetingInvite) {
      throw new TypeError("directMessenger.updateMeetingInvite is required");
    }
    this.store = requireStore(store);
    this.directMessenger = directMessenger;
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
      return { claimed: 0, sent: 0, updated: 0, failed: 0, skipped: 0, stale: 0, busy: true };
    }
    this.running = true;
    const result = { claimed: 0, sent: 0, updated: 0, failed: 0, skipped: 0, stale: 0, busy: false };
    const execution = (async () => {
      const sendClaims = this.store.claimDirectInviteSends({
        nowMs: Number(this.now()),
        leaseMs: this.leaseMs,
        limit: this.batchSize,
      });
      result.claimed += sendClaims.length;
      for (const claim of sendClaims) {
        const outcome = await this.deliverInitialInvite(claim);
        result[outcome] += 1;
      }
      const claims = this.store.claimDirectInviteUpdates({
        nowMs: Number(this.now()),
        leaseMs: this.leaseMs,
        limit: this.batchSize,
      });
      result.claimed += claims.length;
      for (const claim of claims) {
        const outcome = await this.deliver(claim);
        result[outcome] += 1;
      }
    })();
    this.activeTick = execution;
    try {
      await execution;
    } catch (error) {
      result.failed += 1;
      this.logger.error?.(`[direct-invite-update] tick_failed code=${directMessageErrorCode(error)}`);
    } finally {
      if (this.activeTick === execution) this.activeTick = null;
      this.running = false;
    }
    return result;
  }

  async recentInviteMessages(data, requireCurrentMember) {
    if (typeof this.directMessenger.findMeetingInviteMessages !== "function") return [];
    return this.directMessenger.findMeetingInviteMessages({
      meeting: data.meeting,
      recipient: data.invitee,
      requireCurrentMember,
    });
  }

  async deleteInviteMessages(data, claim, messages) {
    if (!messages.length) return;
    if (typeof this.directMessenger.deleteDirectMessage !== "function") {
      throw Object.assign(new Error("Direct message deletion is unavailable"), {
        code: "direct_delete_unavailable",
      });
    }
    for (const item of messages) {
      await this.directMessenger.deleteDirectMessage({
        meeting: data.meeting,
        recipient: data.invitee,
        messageId: item.messageId,
        beforeDelete: async () => this.store.isDirectInviteSendClaimCurrent(claim),
      });
    }
  }

  async compensateInitialInvite(data, claim, messageId) {
    if (!messageId) return;
    const action = this.store.reconcileDirectInviteSendStaleReceipt(claim, messageId, {
      nowMs: Number(this.now()),
    });
    if (action !== "delete" || typeof this.directMessenger.deleteDirectMessage !== "function") return;
    try {
      await this.directMessenger.deleteDirectMessage({
        meeting: data.meeting,
        recipient: data.invitee,
        messageId,
      });
    } catch (error) {
      const code = directMessageErrorCode(error);
      if (!ALREADY_GONE_DELETE_CODES.has(code)) {
        this.logger.warn?.(`[direct-invite-send] compensation_failed code=${code}`);
      }
    }
  }

  async deliverInitialInvite(claim) {
    if (!this.store.isDirectInviteSendClaimCurrent(claim)) return "stale";
    let data;
    try {
      data = this.store.getDirectInviteSendData(claim);
    } catch (error) {
      const code = directMessageErrorCode(error);
      const retryable = !NON_RETRYABLE_CODES.has(code);
      const persisted = this.store.markDirectInviteSendFailed(claim, {
        errorCode: code,
        retryable,
        maxAttempts: this.maxAttempts,
        failedAtMs: Number(this.now()),
      });
      if (!persisted) return "stale";
      return retryable && Number(claim.attempts) < this.maxAttempts ? "failed" : "skipped";
    }
    if (!data) return "stale";
    if (data.meeting.status !== "active") return this.retireInactiveInitialInvite(data, claim);

    let visibleMessageId = null;
    try {
      const recent = await this.recentInviteMessages(data, true);
      if (recent.length) {
        const [keep, ...duplicates] = recent;
        await this.deleteInviteMessages(data, claim, duplicates);
        await this.directMessenger.updateMeetingInvite({
          meeting: data.meeting,
          recipient: data.invitee,
          messageId: keep.messageId,
          beforeEdit: async () => this.store.isDirectInviteSendClaimCurrent(claim),
        });
        visibleMessageId = keep.messageId;
      } else {
        const receipt = await this.directMessenger.sendMeetingInvite({
          meeting: data.meeting,
          recipient: data.invitee,
          beforeSend: async () => this.store.isDirectInviteSendClaimCurrent(claim),
        });
        visibleMessageId = receipt?.messageId || null;
      }

      let persisted;
      try {
        persisted = this.store.markDirectInviteSendSucceeded(claim, visibleMessageId, {
          sentAtMs: Number(this.now()),
        });
      } catch (error) {
        this.logger.error?.(`[direct-invite-send] receipt_persist_failed code=${directMessageErrorCode(error)}`);
        // Keep the sending lease.  After restart/lease expiry the bounded recent
        // DM scan can recover this exact bot-authored invitation without a resend.
        return "failed";
      }
      if (!persisted) {
        await this.compensateInitialInvite(data, claim, visibleMessageId);
        return "stale";
      }
      return "sent";
    } catch (error) {
      const code = directMessageErrorCode(error);
      if (code === "stale_invite_send" || code === "stale_invite_update") return "stale";
      if (DEPARTED_MEMBER_CODES.has(code)) {
        return this.retireInitialInviteForDepartedMember(data, claim, code);
      }
      const retryable = !NON_RETRYABLE_CODES.has(code);
      const persisted = this.store.markDirectInviteSendFailed(claim, {
        errorCode: code,
        retryable,
        maxAttempts: this.maxAttempts,
        failedAtMs: Number(this.now()),
      });
      if (!persisted) return "stale";
      this.logger.warn?.(`[direct-invite-send] delivery_failed code=${code}`);
      return retryable && Number(claim.attempts) < this.maxAttempts ? "failed" : "skipped";
    }
  }

  async retireInitialInviteForDepartedMember(data, claim, memberErrorCode) {
    try {
      const recent = await this.recentInviteMessages(data, false);
      await this.deleteInviteMessages(data, claim, recent);
    } catch (error) {
      const code = directMessageErrorCode(error);
      if (!ALREADY_GONE_DELETE_CODES.has(code) && !NON_RETRYABLE_CODES.has(code)) {
        const persisted = this.store.markDirectInviteSendFailed(claim, {
          errorCode: code,
          retryable: true,
          maxAttempts: this.maxAttempts,
          failedAtMs: Number(this.now()),
        });
        return persisted ? "failed" : "stale";
      }
    }
    const persisted = this.store.markDirectInviteSendFailed(claim, {
      errorCode: memberErrorCode,
      retryable: false,
      maxAttempts: this.maxAttempts,
      failedAtMs: Number(this.now()),
    });
    return persisted ? "skipped" : "stale";
  }

  async retireInactiveInitialInvite(data, claim) {
    try {
      const recent = await this.recentInviteMessages(data, false);
      await this.deleteInviteMessages(data, claim, recent);
    } catch (error) {
      const code = directMessageErrorCode(error);
      if (!ALREADY_GONE_DELETE_CODES.has(code)) {
        const retryable = !NON_RETRYABLE_CODES.has(code) && code !== "direct_delete_unavailable";
        const persisted = this.store.markDirectInviteSendFailed(claim, {
          errorCode: code,
          retryable,
          maxAttempts: this.maxAttempts,
          failedAtMs: Number(this.now()),
        });
        if (!persisted) return "stale";
        return retryable && Number(claim.attempts) < this.maxAttempts ? "failed" : "skipped";
      }
    }
    const errorCode = data.meeting.status === "cancelled" ? "meeting_cancelled" : "meeting_completed";
    return this.store.closeDirectInviteSendForInactive(claim, { errorCode }) ? "skipped" : "stale";
  }

  async deliver(claim) {
    if (!this.store.isDirectInviteUpdateClaimCurrent(claim)) return "stale";
    try {
      const reminder = this.store.personalReminders?.getMeetingReminders?.(claim.meetingId, claim.userId);
      await this.directMessenger.updateMeetingInvite({
        meeting: claim.meeting,
        recipient: {
          userId: claim.userId,
          displayName: claim.displayName,
          personalReminderMinutes: reminder?.minutes || [],
        },
        messageId: claim.dmMessageId,
        beforeEdit: async () => this.store.isDirectInviteUpdateClaimCurrent(claim),
      });
      if (!this.store.markDirectInviteUpdateSucceeded(claim)) {
        this.logger.warn?.("[direct-invite-update] receipt_stale");
        return "stale";
      }
      return "updated";
    } catch (error) {
      const code = directMessageErrorCode(error);
      if (code === "stale_invite_update") return "stale";
      if (DEPARTED_MEMBER_CODES.has(code)) return this.retireDepartedInvite(claim);
      const retryable = !NON_RETRYABLE_CODES.has(code);
      const persisted = this.store.markDirectInviteUpdateFailed(claim, {
        errorCode: code,
        retryable,
        maxAttempts: this.maxAttempts,
        failedAtMs: Number(this.now()),
      });
      if (!persisted) return "stale";
      this.logger.warn?.(`[direct-invite-update] delivery_failed code=${code}`);
      return retryable && Number(claim.attempts) < this.maxAttempts ? "failed" : "skipped";
    }
  }

  async retireDepartedInvite(claim) {
    try {
      if (typeof this.directMessenger.deleteDirectMessage !== "function") {
        throw Object.assign(new Error("Direct message deletion is unavailable"), {
          code: "direct_delete_unavailable",
        });
      }
      await this.directMessenger.deleteDirectMessage({
        meeting: claim.meeting,
        recipient: { userId: claim.userId },
        messageId: claim.dmMessageId,
        beforeDelete: async () => this.store.isDirectInviteUpdateClaimCurrent(claim),
      });
    } catch (error) {
      const code = directMessageErrorCode(error);
      if (code === "stale_invite_update") return "stale";
      if (!ALREADY_GONE_DELETE_CODES.has(code)) {
        const retryable = !NON_RETRYABLE_CODES.has(code) && code !== "direct_delete_unavailable";
        const persisted = this.store.markDirectInviteUpdateFailed(claim, {
          errorCode: code,
          retryable,
          maxAttempts: this.maxAttempts,
          failedAtMs: Number(this.now()),
        });
        if (!persisted) return "stale";
        this.logger.warn?.(`[direct-invite-update] departed_delete_failed code=${code}`);
        return retryable && Number(claim.attempts) < this.maxAttempts ? "failed" : "skipped";
      }
    }
    if (!this.store.markDirectInviteUpdateSucceeded(claim)) return "stale";
    return "updated";
  }
}

export const directInviteUpdateNonRetryableCodes = NON_RETRYABLE_CODES;
