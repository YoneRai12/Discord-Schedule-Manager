import { buildNotificationPayload } from "./discord-ui.mjs";

export class MeetingScheduler {
  constructor({ client, store, sheetsSync, intervalSeconds = 15, maxLateMinutes = 10, logger = console }) {
    this.client = client;
    this.store = store;
    this.sheetsSync = sheetsSync;
    this.intervalMs = intervalSeconds * 1_000;
    this.maxLateMinutes = maxLateMinutes;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.activeTick = null;
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    const execution = (async () => {
      const deliveries = this.store.claimDueDeliveries({ maxLateMinutes: this.maxLateMinutes });
      for (const delivery of deliveries) {
        await this.deliver(delivery);
      }
    })();
    this.activeTick = execution;
    try {
      await execution;
    } finally {
      if (this.activeTick === execution) this.activeTick = null;
      this.running = false;
    }
  }

  isCurrent(delivery) {
    return typeof this.store.isDeliveryClaimCurrent !== "function"
      || this.store.isDeliveryClaimCurrent(delivery);
  }

  async deleteStaleMessage(message) {
    try {
      await message?.delete?.();
    } catch (error) {
      const errorCode = String(error?.code || error?.status || "delete_failed").slice(0, 80);
      this.logger.warn?.(`[scheduler] stale_message_delete_failed code=${errorCode}`);
    }
  }

  async deliver(delivery) {
    let message;
    try {
      if (!this.isCurrent(delivery)) return false;
      const channel = await this.client.channels.fetch(delivery.channelId);
      if (!channel?.isTextBased?.()) throw Object.assign(new Error("通知先がテキストチャンネルではありません"), { code: "invalid_channel" });
      const rsvps = this.store.listRsvps(delivery.meetingId);
      if (!this.isCurrent(delivery)) return false;
      message = await channel.send(buildNotificationPayload(delivery, rsvps));
      if (!this.isCurrent(delivery)) {
        await this.deleteStaleMessage(message);
        return false;
      }
    } catch (error) {
      const errorCode = String(error?.code || error?.status || "send_failed").slice(0, 80);
      this.store.markDeliveryFailed(delivery.meetingId, delivery.offsetMinutes, {
        scheduleRevision: delivery.scheduleRevision,
        claimToken: delivery.claimToken,
        errorCode,
      });
      this.logger.error(`[scheduler] 通知失敗 meeting=${delivery.meetingId} code=${errorCode}`);
      return false;
    }
    try {
      const persisted = this.store.markDeliverySent(delivery.meetingId, delivery.offsetMinutes, {
        scheduleRevision: delivery.scheduleRevision,
        claimToken: delivery.claimToken,
        discordMessageId: message.id,
      });
      if (persisted === false) {
        this.logger.warn?.("[scheduler] sent_receipt_stale");
        await this.deleteStaleMessage(message);
        return false;
      }
      this.sheetsSync?.requestSync();
      return true;
    } catch (error) {
      try {
        this.store.markDeliveryUncertain?.(delivery.meetingId, delivery.offsetMinutes, {
          scheduleRevision: delivery.scheduleRevision,
          claimToken: delivery.claimToken,
          discordMessageId: message?.id ?? null,
          errorCode: "receipt_persist_failed",
        });
      } catch {}
      const errorCode = String(error?.code || error?.status || "receipt_persist_failed").slice(0, 80);
      this.logger.error(`[scheduler] 通知記録失敗 code=${errorCode}`);
      return false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
}
