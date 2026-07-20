import assert from "node:assert/strict";
import test from "node:test";
import { DiscordDirectMessenger } from "../src/discord-direct-messenger.mjs";
import { PersonalReminderScheduler } from "../src/personal-reminder-scheduler.mjs";

function fixtureStore(deliveries = []) {
  const calls = { claims: [], sent: [], failed: [] };
  return {
    calls,
    personalReminders: {
      claimDueDeliveries: async (options) => {
        calls.claims.push(options);
        return deliveries;
      },
      isClaimCurrent: async () => true,
      markSent: async (...args) => calls.sent.push(args),
      markFailed: async (...args) => calls.failed.push(args),
    },
  };
}

test("複数の個人通知を一括claimして、それぞれ一度だけ送信済みにする", async () => {
  const nowMs = 2_000_000;
  const deliveries = [
    { deliveryId: "delivery-a", dueAtMs: nowMs - 1_000, offsetMinutes: 60 },
    { deliveryId: "delivery-b", dueAtMs: nowMs, offsetMinutes: 10 },
  ];
  const store = fixtureStore(deliveries);
  const sent = [];
  const scheduler = new PersonalReminderScheduler({
    store,
    directMessenger: { sendPersonalReminder: async (delivery) => {
      sent.push(delivery.deliveryId);
      return { messageId: `message-${sent.length}` };
    } },
    now: () => nowMs,
    maxLateMinutes: 10,
  });

  const result = await scheduler.tick();

  assert.deepEqual(result, { claimed: 2, sent: 2, failed: 0, skipped: false });
  assert.deepEqual(sent, ["delivery-a", "delivery-b"]);
  assert.equal(store.calls.sent.length, 2);
  assert.deepEqual(store.calls.claims[0], {
    nowMs,
    maxLateMinutes: 10,
    leaseMs: 120_000,
    limit: 25,
  });
});

test("延期または中止で古くなった個別DM claimは送信直前に止める", async () => {
  let checks = 0;
  let sends = 0;
  const calls = { sent: 0, failed: 0 };
  const scheduler = new PersonalReminderScheduler({
    store: {
      personalReminders: {
        claimDueDeliveries: async () => [{
          id: "delivery-old",
          deliveryId: "delivery-old",
          dueAtMs: 2_000_000,
          scheduleRevision: 0,
          claimToken: "claim-old",
        }],
        isClaimCurrent: async () => {
          checks += 1;
          return checks === 1;
        },
        markSent: async () => { calls.sent += 1; },
        markFailed: async () => { calls.failed += 1; },
      },
    },
    directMessenger: {
      sendPersonalReminder: async () => {
        sends += 1;
        return { messageId: "must-not-send" };
      },
    },
    now: () => 2_000_000,
  });

  const result = await scheduler.tick();
  assert.equal(checks, 2);
  assert.equal(sends, 0);
  assert.equal(calls.sent, 0);
  assert.equal(calls.failed, 0);
  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 0, stale: 1, skipped: false });
});

test("個別DM送信中に予定が更新された場合は古い通知を削除する", async () => {
  let checks = 0;
  let sends = 0;
  let deletes = 0;
  let marked = 0;
  const scheduler = new PersonalReminderScheduler({
    store: {
      personalReminders: {
        claimDueDeliveries: async () => [{
          id: "delivery-old",
          deliveryId: "delivery-old",
          guildId: "guild-example",
          userId: "user-example",
          dueAtMs: 2_000_000,
          scheduleRevision: 0,
          claimToken: "claim-old",
        }],
        isClaimCurrent: async () => {
          checks += 1;
          return checks < 3;
        },
        markSent: async () => { marked += 1; },
        markFailed: async () => { marked += 1; },
      },
    },
    directMessenger: {
      sendPersonalReminder: async () => {
        sends += 1;
        return { messageId: "stale-dm" };
      },
      deleteDirectMessage: async ({ messageId }) => {
        assert.equal(messageId, "stale-dm");
        deletes += 1;
      },
    },
    now: () => 2_000_000,
  });

  const result = await scheduler.tick();
  assert.equal(checks, 3);
  assert.equal(sends, 1);
  assert.equal(deletes, 1);
  assert.equal(marked, 0);
  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 0, stale: 1, skipped: false });
});

test("個別DMのstopAndDrainも進行中送信を待つ", async () => {
  let releaseSend;
  const barrier = new Promise((resolve) => { releaseSend = resolve; });
  const store = fixtureStore([{
    id: "delivery-current",
    deliveryId: "delivery-current",
    dueAtMs: 4_000_000,
    scheduleRevision: 0,
    claimToken: "claim-current",
  }]);
  const scheduler = new PersonalReminderScheduler({
    store,
    directMessenger: {
      sendPersonalReminder: async () => {
        await barrier;
        return { messageId: "message-current" };
      },
    },
    now: () => 4_000_000,
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
  assert.equal(store.calls.sent.length, 1);
});

test("同時tickは再入せず、最大遅延を超えた配送は送らない", async () => {
  const nowMs = 5_000_000;
  let releaseClaim;
  const claimBarrier = new Promise((resolve) => { releaseClaim = resolve; });
  let claimCount = 0;
  const failed = [];
  const store = {
    personalReminders: {
      claimDueDeliveries: async () => {
        claimCount += 1;
        await claimBarrier;
        return [{ deliveryId: "late", dueAtMs: nowMs - 11 * 60_000 }];
      },
      markSent: async () => assert.fail("送信済みになりました"),
      markFailed: async (...args) => failed.push(args),
    },
  };
  const scheduler = new PersonalReminderScheduler({
    store,
    directMessenger: { sendPersonalReminder: async () => assert.fail("DMが送られました") },
    now: () => nowMs,
    maxLateMinutes: 10,
  });

  const first = scheduler.tick();
  const second = await scheduler.tick();
  releaseClaim();
  const firstResult = await first;

  assert.equal(claimCount, 1);
  assert.equal(second.skipped, true);
  assert.equal(firstResult.failed, 1);
  assert.equal(failed[0][0], "late");
  assert.equal(failed[0][1].errorCode, "too_late");
  assert.equal(failed[0][1].retryable, false);
  assert.equal(failed[0][1].maxAttempts, 0);
});

test("start/stopは多重タイマーを作らず再開できる", () => {
  const store = fixtureStore();
  const scheduler = new PersonalReminderScheduler({
    store,
    directMessenger: { sendPersonalReminder: async () => ({ messageId: "unused" }) },
    intervalSeconds: 60,
  });
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(scheduler.stop(), true);
  assert.equal(scheduler.stop(), false);
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.stop(), true);
});

test("DiscordDirectMessengerは在籍確認後にのみDMし、mentionを無効化する", async () => {
  const sentPayloads = [];
  const editedPayloads = [];
  let guildFetches = 0;
  const client = {
    users: {
      fetch: async () => ({
        bot: false,
        system: false,
        createDM: async () => ({
          messages: {
            fetch: async () => ({
              id: "message-template",
              edit: async (payload) => { editedPayloads.push(payload); },
              delete: async () => {},
            }),
          },
        }),
      }),
    },
    guilds: {
      fetch: async () => {
        guildFetches += 1;
        return {
          id: "guild-template",
          members: {
            fetch: async () => ({
              guild: { id: "guild-template" },
              user: {
                bot: false,
                system: false,
                send: async (payload) => {
                  sentPayloads.push(payload);
                  return { id: "message-template" };
                },
                createDM: async () => ({
                  messages: {
                    fetch: async () => ({
                      id: "message-template",
                      edit: async (payload) => { editedPayloads.push(payload); },
                    }),
                  },
                }),
              },
            }),
          },
        };
      },
    },
  };
  const messenger = new DiscordDirectMessenger({
    client,
    guildId: "guild-template",
    buildInvitePayload: () => ({ content: "meeting invitation", allowedMentions: { parse: ["everyone"] } }),
    buildReminderPayload: () => ({ content: "meeting reminder" }),
    logger: { warn: () => {} },
  });

  const receipt = await messenger.sendMeetingInvite({
    meeting: { guildId: "guild-template" },
    recipient: { userId: "member-template" },
  });

  assert.deepEqual(receipt, { messageId: "message-template" });
  assert.equal(guildFetches, 1);
  assert.deepEqual(sentPayloads[0].allowedMentions, { parse: [], repliedUser: false });
  const updateReceipt = await messenger.updateMeetingInvite({
    meeting: { guildId: "guild-template" },
    recipient: { userId: "member-template" },
    messageId: "message-template",
  });
  assert.deepEqual(updateReceipt, { messageId: "message-template" });
  assert.equal(guildFetches, 2, "既存DMへ最新URLを反映する直前にもGuild在籍を確認する");
  assert.deepEqual(editedPayloads[0].allowedMentions, { parse: [], repliedUser: false });
  await messenger.deleteDirectMessage({
    meeting: { guildId: "guild-template" },
    recipient: { userId: "member-template" },
    messageId: "message-template",
  });
  assert.equal(guildFetches, 2, "補償削除は退会者にも実行できるようGuild在籍確認をしない");
});

test("送信済みreceiptの保存に失敗した場合は再送不可として記録する", async () => {
  const nowMs = 8_000_000;
  const failed = [];
  const scheduler = new PersonalReminderScheduler({
    store: {
      personalReminders: {
        claimDueDeliveries: async () => [],
        markSent: async () => { throw Object.assign(new Error("database unavailable"), { code: "db_busy" }); },
        markFailed: async (...args) => failed.push(args),
      },
    },
    directMessenger: { sendPersonalReminder: async () => ({ messageId: "already-visible" }) },
    now: () => nowMs,
    logger: { error: () => {}, warn: () => {} },
  });

  const sent = await scheduler.deliver({ deliveryId: "receipt-case", dueAtMs: nowMs });

  assert.equal(sent, false);
  assert.equal(failed.length, 1);
  assert.equal(failed[0][1].errorCode, "receipt_persist_failed");
  assert.equal(failed[0][1].possiblySent, true);
  assert.equal(failed[0][1].maxAttempts, 0);
});

test("DM失敗ログにDiscord IDや本文を含めない", async () => {
  const logs = [];
  const client = {
    guilds: {
      fetch: async () => ({
        id: "guild-secret-value",
        members: {
          fetch: async () => ({
            guild: { id: "guild-secret-value" },
            user: {
              bot: false,
              system: false,
              send: async () => { throw Object.assign(new Error("sensitive meeting body"), { code: 50007 }); },
            },
          }),
        },
      }),
    },
  };
  const messenger = new DiscordDirectMessenger({
    client,
    guildId: "guild-secret-value",
    buildInvitePayload: () => ({ content: "sensitive meeting body" }),
    buildReminderPayload: () => ({ content: "unused" }),
    logger: { warn: (line) => logs.push(line) },
  });

  await assert.rejects(() => messenger.sendMeetingInvite({
    meeting: { guildId: "guild-secret-value" },
    recipient: { userId: "user-secret-value" },
  }));

  assert.equal(logs.length, 1);
  assert.match(logs[0], /code=50007/u);
  assert.doesNotMatch(logs[0], /guild-secret|user-secret|sensitive meeting/u);
});
