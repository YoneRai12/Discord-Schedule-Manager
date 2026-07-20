import { directMessageErrorCode } from "./discord-direct-messenger.mjs";

const NON_RETRYABLE_CODES = new Set([
  "10007", // Unknown Member
  "10013", // Unknown User
  "50007", // Cannot send messages to this user
  "guild_mismatch",
  "not_guild_member",
  "not_human_member",
  "recipient_missing",
  "invalid_dm_payload",
]);

function requireReminderStore(store) {
  const reminders = store?.personalReminders;
  for (const method of ["claimDueDeliveries", "markSent", "markFailed"]) {
    if (typeof reminders?.[method] !== "function") {
      throw new TypeError(`store.personalReminders.${method} is required`);
    }
  }
  return reminders;
}

function deliveryId(delivery) {
  const id = delivery?.deliveryId ?? delivery?.id;
  if (!id) throw Object.assign(new Error("Claimed reminder has no delivery id"), { code: "delivery_id_missing" });
  return String(id);
}

/**
 * Claims persisted, per-user reminder occurrences and delivers them by DM.
 * Multiple reminder offsets are separate delivery records in the store.
 * Atomic claiming + a process-local tick guard prevents ordinary duplicates.
 */
export class PersonalReminderScheduler {
  constructor({
    store,
    directMessenger,
    intervalSeconds = 15,
    maxLateMinutes = 10,
    leaseMs = 120_000,
    batchSize = 25,
    now = () => Date.now(),
    logger = console,
  }) {
    if (!directMessenger?.sendPersonalReminder) {
      throw new TypeError("directMessenger.sendPersonalReminder is required");
    }
    this.reminders = requireReminderStore(store);
    this.directMessenger = directMessenger;
    this.intervalMs = Math.max(1, Number(intervalSeconds)) * 1_000;
    this.maxLateMinutes = Math.max(0, Number(maxLateMinutes));
    this.leaseMs = Math.max(1_000, Number(leaseMs));
    this.batchSize = Math.max(1, Math.min(100, Number(batchSize)));
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
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async tick() {
    if (this.running) return { claimed: 0, sent: 0, failed: 0, skipped: true };
    this.running = true;
    const result = { claimed: 0, sent: 0, failed: 0, skipped: false };
    let stale = 0;
    const execution = (async () => {
      const nowMs = Number(this.now());
      const deliveries = await this.reminders.claimDueDeliveries({
        nowMs,
        maxLateMinutes: this.maxLateMinutes,
        leaseMs: this.leaseMs,
        limit: this.batchSize,
      });
      result.claimed = deliveries.length;
      for (const delivery of deliveries) {
        const sent = await this.deliver(delivery, nowMs);
        if (sent === null) stale += 1;
        else if (sent) result.sent += 1;
        else result.failed += 1;
      }
    })();
    this.activeTick = execution;
    try {
      await execution;
    } catch (error) {
      result.failed += 1;
      this.logger.error?.(`[personal-reminder-scheduler] tick_failed code=${directMessageErrorCode(error)}`);
    } finally {
      if (this.activeTick === execution) this.activeTick = null;
      this.running = false;
    }
    if (stale) result.stale = stale;
    return result;
  }

  isCurrent(delivery) {
    return typeof this.reminders.isClaimCurrent !== "function"
      || this.reminders.isClaimCurrent(delivery);
  }

  async claimIsCurrent(delivery) {
    const current = this.isCurrent(delivery);
    return current && typeof current.then === "function" ? await current : current;
  }

  async deleteStaleReminder(delivery, receipt) {
    if (!receipt?.messageId || typeof this.directMessenger.deleteDirectMessage !== "function") return;
    try {
      await this.directMessenger.deleteDirectMessage({
        meeting: { guildId: delivery?.guildId ?? delivery?.meeting?.guildId },
        recipient: { userId: delivery?.userId ?? delivery?.recipient?.userId },
        messageId: receipt.messageId,
      });
    } catch (error) {
      this.logger.warn?.(`[personal-reminder-scheduler] stale_message_delete_failed code=${directMessageErrorCode(error)}`);
    }
  }

  async deliver(delivery, nowMs = Number(this.now())) {
    let id;
    try {
      id = deliveryId(delivery);
      if (!await this.claimIsCurrent(delivery)) return null;
      const dueAtMs = Number(delivery.dueAtMs);
      const oldestAllowed = nowMs - this.maxLateMinutes * 60_000;
      if (!Number.isFinite(dueAtMs) || dueAtMs < oldestAllowed) {
        await this.reminders.markFailed(id, {
          errorCode: "too_late",
          retryable: false,
          maxAttempts: 0,
          failedAtMs: nowMs,
        });
        return false;
      }

      const current = this.isCurrent(delivery);
      if (current && typeof current.then === "function") {
        if (!await current) return null;
      } else if (!current) {
        return null;
      }
      const receipt = await this.directMessenger.sendPersonalReminder(delivery);
      if (!await this.claimIsCurrent(delivery)) {
        await this.deleteStaleReminder(delivery, receipt);
        return null;
      }
      try {
        const persisted = await this.reminders.markSent(id, {
          scheduleRevision: delivery.scheduleRevision,
          claimToken: delivery.claimToken,
          discordMessageId: receipt?.messageId ?? null,
          sentAtMs: Number(this.now()),
        });
        if (persisted === false) {
          this.logger.warn?.("[personal-reminder-scheduler] sent_receipt_stale");
          await this.deleteStaleReminder(delivery, receipt);
          return null;
        }
      } catch (persistError) {
        // The DM may already be visible.  Mark it non-retryable so a temporary
        // receipt-persistence failure does not create a duplicate notification.
        await this.safeMarkFailed(id, {
          errorCode: "receipt_persist_failed",
          scheduleRevision: delivery.scheduleRevision,
          claimToken: delivery.claimToken,
          retryable: false,
          maxAttempts: 0,
          possiblySent: true,
          discordMessageId: receipt?.messageId ?? null,
          failedAtMs: Number(this.now()),
        });
        this.logger.error?.(`[personal-reminder-scheduler] receipt_failed code=${directMessageErrorCode(persistError)}`);
        return false;
      }
      return true;
    } catch (error) {
      const errorCode = directMessageErrorCode(error);
      if (id) {
        const retryable = !NON_RETRYABLE_CODES.has(errorCode);
        await this.safeMarkFailed(id, {
          errorCode,
          scheduleRevision: delivery.scheduleRevision,
          claimToken: delivery.claimToken,
          retryable,
          ...(retryable ? {} : { maxAttempts: 0 }),
          failedAtMs: Number(this.now()),
        });
      }
      this.logger.warn?.(`[personal-reminder-scheduler] delivery_failed code=${errorCode}`);
      return false;
    }
  }

  async safeMarkFailed(id, details) {
    try {
      await this.reminders.markFailed(id, details);
    } catch (error) {
      this.logger.error?.(`[personal-reminder-scheduler] failure_receipt_failed code=${directMessageErrorCode(error)}`);
    }
  }
}
