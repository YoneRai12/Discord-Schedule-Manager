import assert from "node:assert/strict";
import test from "node:test";
import { MeetingScheduler } from "../src/scheduler.mjs";

test("開始時通知だけ@everyoneを明示許可して送信済みにする", async () => {
  const sentPayloads = [];
  const marked = [];
  const delivery = {
    meetingId: "ABCD1234",
    channelId: "channel-example",
    offsetMinutes: 0,
    mentionEveryone: true,
    title: "運営定例",
    startsAtMs: Date.now(),
    endsAtMs: Date.now() + 60_000,
    meetingUrl: "https://meet.example.com/room",
  };
  const store = {
    claimDueDeliveries: () => [delivery],
    listRsvps: () => [{ status: "attending" }, { status: "declined" }],
    markDeliverySent: (...args) => marked.push(args),
    markDeliveryFailed: () => assert.fail("失敗扱いになりました"),
  };
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async (payload) => {
          sentPayloads.push(payload);
          return { id: "message-1" };
        },
      }),
    },
  };
  const scheduler = new MeetingScheduler({ client, store, intervalSeconds: 15, maxLateMinutes: 10 });
  await scheduler.tick();

  assert.equal(sentPayloads.length, 1);
  assert.match(sentPayloads[0].content, /^@everyone/u);
  assert.deepEqual(sentPayloads[0].allowedMentions, { parse: ["everyone"] });
  assert.equal(marked.length, 1);
});
