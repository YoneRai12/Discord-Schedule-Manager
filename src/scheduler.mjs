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
    try {
      const deliveries = this.store.claimDueDeliveries({ maxLateMinutes: this.maxLateMinutes });
      for (const delivery of deliveries) {
        await this.deliver(delivery);
      }
    } finally {
      this.running = false;
    }
  }

  async deliver(delivery) {
    try {
      const channel = await this.client.channels.fetch(delivery.channelId);
      if (!channel?.isTextBased?.()) throw Object.assign(new Error("通知先がテキストチャンネルではありません"), { code: "invalid_channel" });
      const rsvps = this.store.listRsvps(delivery.meetingId);
      const message = await channel.send(buildNotificationPayload(delivery, rsvps));
      this.store.markDeliverySent(delivery.meetingId, delivery.offsetMinutes, { discordMessageId: message.id });
      this.sheetsSync?.requestSync();
    } catch (error) {
      const errorCode = String(error?.code || error?.status || "send_failed").slice(0, 80);
      this.store.markDeliveryFailed(delivery.meetingId, delivery.offsetMinutes, { errorCode });
      this.logger.error(`[scheduler] 通知失敗 meeting=${delivery.meetingId} code=${errorCode}`);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
