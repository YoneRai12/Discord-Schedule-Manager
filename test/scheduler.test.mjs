import assert from "node:assert/strict";
import test from "node:test";
import { MeetingScheduler } from "../src/scheduler.mjs";

test("開始時通知は参加を押した人だけ明示許可して送信済みにする", async () => {
  const sentPayloads = [];
  const marked = [];
  const discordId = (suffix) => `${"1".repeat(17)}${suffix}`;
  const attendingA = discordId("1");
  const attendingB = discordId("2");
  const maybe = discordId("3");
  const declined = discordId("4");
  const delivery = {
    meetingId: "ABCD1234",
    channelId: "channel-example",
    offsetMinutes: 0,
    mentionAttendees: true,
    title: "運営定例",
    startsAtMs: Date.now(),
    endsAtMs: Date.now() + 60_000,
    meetingUrl: "https://meet.example.com/room",
  };
  const store = {
    claimDueDeliveries: () => [delivery],
    isDeliveryClaimCurrent: () => true,
    listRsvps: () => [
      { userId: attendingA, status: "attending" },
      { userId: maybe, status: "maybe" },
      { userId: declined, status: "declined" },
      { userId: attendingB, status: "attending" },
    ],
    markDeliverySent: (...args) => {
      marked.push(args);
      return true;
    },
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
  assert.match(sentPayloads[0].content, new RegExp(`^<@${attendingA}> <@${attendingB}>\\n`, "u"));
  assert.doesNotMatch(sentPayloads[0].content, /@everyone/u);
  assert.doesNotMatch(sentPayloads[0].content, new RegExp(`${maybe}|${declined}`, "u"));
  assert.deepEqual(sentPayloads[0].allowedMentions, {
    parse: [],
    users: [attendingA, attendingB],
  });
  assert.equal(marked.length, 1);
});

test("claim後に延期または中止された配送は送信直前の再確認で止める", async () => {
  let checks = 0;
  let sends = 0;
  let marked = 0;
  const delivery = {
    meetingId: "ABCD1234",
    channelId: "channel-example",
    offsetMinutes: 0,
    scheduleRevision: 0,
    claimToken: "claim-old",
    startsAtMs: Date.now(),
    endsAtMs: Date.now() + 60_000,
    title: "会議",
    meetingUrl: "https://meet.example.com/room",
  };
  const scheduler = new MeetingScheduler({
    store: {
      claimDueDeliveries: () => [delivery],
      isDeliveryClaimCurrent: () => {
        checks += 1;
        return checks === 1;
      },
      listRsvps: () => [],
      markDeliverySent: () => { marked += 1; },
      markDeliveryFailed: () => { marked += 1; },
    },
    client: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => {
            sends += 1;
            return { id: "must-not-send" };
          },
        }),
      },
    },
    intervalSeconds: 15,
  });

  await scheduler.tick();
  assert.equal(checks, 2);
  assert.equal(sends, 0);
  assert.equal(marked, 0);
});

test("Discord送信中に予定が更新された場合は古い通知を削除する", async () => {
  let checks = 0;
  let sends = 0;
  let deletes = 0;
  let marked = 0;
  const delivery = {
    meetingId: "ABCD1234",
    channelId: "channel-example",
    offsetMinutes: 0,
    scheduleRevision: 0,
    claimToken: "claim-old",
    startsAtMs: Date.now(),
    endsAtMs: Date.now() + 60_000,
    title: "会議",
    meetingUrl: "https://meet.example.com/room",
  };
  const scheduler = new MeetingScheduler({
    store: {
      claimDueDeliveries: () => [delivery],
      isDeliveryClaimCurrent: () => {
        checks += 1;
        return checks < 3;
      },
      listRsvps: () => [],
      markDeliverySent: () => { marked += 1; },
      markDeliveryFailed: () => { marked += 1; },
    },
    client: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => {
            sends += 1;
            return {
              id: "stale-message",
              delete: async () => { deletes += 1; },
            };
          },
        }),
      },
    },
    intervalSeconds: 15,
  });

  await scheduler.tick();
  assert.equal(checks, 3);
  assert.equal(sends, 1);
  assert.equal(deletes, 1);
  assert.equal(marked, 0);
});

test("stopAndDrainは進行中の送信完了まで待ってから停止する", async () => {
  let releaseSend;
  const sendBarrier = new Promise((resolve) => { releaseSend = resolve; });
  let marked = false;
  const scheduler = new MeetingScheduler({
    store: {
      claimDueDeliveries: () => [{
        meetingId: "ABCD1234",
        channelId: "channel-example",
        offsetMinutes: 0,
        scheduleRevision: 0,
        claimToken: "claim-current",
        startsAtMs: Date.now(),
        endsAtMs: Date.now() + 60_000,
        title: "会議",
        meetingUrl: "https://meet.example.com/room",
      }],
      isDeliveryClaimCurrent: () => true,
      listRsvps: () => [],
      markDeliverySent: () => {
        marked = true;
        return true;
      },
      markDeliveryFailed: () => false,
    },
    client: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => {
            await sendBarrier;
            return { id: "message-1" };
          },
        }),
      },
    },
    intervalSeconds: 60,
  });

  const tick = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  let drained = false;
  const stopping = scheduler.stopAndDrain(1_000).then((value) => {
    drained = value;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  releaseSend();
  assert.equal(await stopping, true);
  await tick;
  assert.equal(marked, true);
});

test("送信成功後のreceipt保存失敗は再送待ちへ戻さない", async () => {
  const uncertain = [];
  const delivery = {
    meetingId: "ABCD1234",
    channelId: "channel-example",
    offsetMinutes: 0,
    scheduleRevision: 2,
    claimToken: "claim-current",
    startsAtMs: Date.now(),
    endsAtMs: Date.now() + 60_000,
    title: "会議",
    meetingUrl: "https://meet.example.com/room",
  };
  const scheduler = new MeetingScheduler({
    store: {
      claimDueDeliveries: () => [delivery],
      isDeliveryClaimCurrent: () => true,
      listRsvps: () => [],
      markDeliverySent: () => { throw Object.assign(new Error("db unavailable"), { code: "db_busy" }); },
      markDeliveryFailed: () => assert.fail("再送待ちへ戻しました"),
      markDeliveryUncertain: (...args) => {
        uncertain.push(args);
        return true;
      },
    },
    client: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => ({ id: "already-visible" }),
        }),
      },
    },
    logger: { error() {}, warn() {} },
  });

  await scheduler.tick();
  assert.equal(uncertain.length, 1);
  assert.equal(uncertain[0][2].errorCode, "receipt_persist_failed");
  assert.equal(uncertain[0][2].discordMessageId, "already-visible");
});
