import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MeetingCoordinator } from "../src/coordinator.mjs";
import { MeetingDatabase } from "../src/database.mjs";
import { DirectInviteUpdateScheduler } from "../src/direct-invite-update-scheduler.mjs";
import { DiscordDirectMessenger } from "../src/discord-direct-messenger.mjs";

function fixture(t, { meetingId = "SEND1234", messageId = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "direct-invite-send-"));
  const databasePath = path.join(root, "meetings.sqlite3");
  const store = new MeetingDatabase(databasePath);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const startsAtMs = Date.now() + 60 * 60_000;
  const meeting = store.createMeeting({
    id: meetingId,
    guildId: "guild-example",
    channelId: "channel-example",
    messageId,
    createdById: "admin-example",
    createdByName: "管理者",
    title: "初回招待テスト",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.example.com/private",
    reminderMinutes: [],
    everyoneOffsets: [],
  });
  return { root, databasePath, store, meeting };
}

function prepare(store, meeting, userId = "member-a") {
  return store.prepareMeetingInvitees(meeting.id, [{ userId, displayName: "メンバーA" }], "admin-example", {
    defaultReminderMinutes: [30],
  }).prepared[0];
}

function messengerStub(overrides = {}) {
  return {
    findMeetingInviteMessages: async () => [],
    sendMeetingInvite: async ({ beforeSend }) => {
      if (beforeSend && !await beforeSend()) throw Object.assign(new Error("stale"), { code: "stale_invite_send" });
      return { messageId: "dm-new" };
    },
    updateMeetingInvite: async ({ messageId, beforeEdit }) => {
      if (beforeEdit && !await beforeEdit()) throw Object.assign(new Error("stale"), { code: "stale_invite_update" });
      return { messageId };
    },
    deleteDirectMessage: async () => {},
    ...overrides,
  };
}

test("招待対象pendingと初回DM outboxを同一transactionで保存する", (t) => {
  const { store, meeting } = fixture(t);
  prepare(store, meeting);
  assert.equal(store.getDirectInviteSendSummary(meeting.id, meeting.updatedAtMs).pending, 1);
  const columns = store.db.prepare("PRAGMA table_info(direct_invite_sends)").all().map((row) => row.name);
  assert.equal(columns.some((name) => /url|body|content/iu.test(name)), false);

  store.db.exec(`
    CREATE TRIGGER reject_initial_invite_outbox
    BEFORE INSERT ON direct_invite_sends
    BEGIN
      SELECT RAISE(ABORT, 'initial outbox blocked');
    END;
  `);
  assert.throws(
    () => prepare(store, meeting, "member-b"),
    /initial outbox blocked/u,
  );
  assert.equal(store.getMeetingInvitee(meeting.id, "member-b"), null);
});

test("schedulerは送信直前CAS後にDMしreceiptとsent状態をatomicに確定する", async (t) => {
  const { store, meeting } = fixture(t);
  prepare(store, meeting);
  store.personalReminders.replaceMeetingReminders({
    meetingId: meeting.id,
    userId: "member-a",
    startsAtMs: meeting.startsAtMs,
    minutes: [60, 10],
  });
  const latest = store.updateMeeting(meeting.id, { title: "送信時の最新版" });
  const calls = [];
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: messengerStub({
      sendMeetingInvite: async (input) => {
        assert.equal(await input.beforeSend(), true);
        calls.push(input);
        return { messageId: "dm-receipt" };
      },
    }),
    logger: { warn() {}, error() {} },
  });

  const result = await scheduler.tick();
  assert.equal(result.sent, 1);
  assert.equal(calls[0].meeting.title, "送信時の最新版");
  assert.deepEqual(calls[0].recipient.personalReminderMinutes, [60, 10]);
  assert.deepEqual(store.getMeetingInvitee(meeting.id, "member-a"), {
    meetingId: meeting.id,
    userId: "member-a",
    displayName: "メンバーA",
    invitedById: "admin-example",
    deliveryStatus: "sent",
    deliveryErrorCode: null,
    dmMessageId: "dm-receipt",
    createdAtMs: store.getMeetingInvitee(meeting.id, "member-a").createdAtMs,
    deliveredAtMs: store.getMeetingInvitee(meeting.id, "member-a").deliveredAtMs,
  });
  assert.equal(store.getDirectInviteSendSummary(meeting.id, latest.updatedAtMs).unresolved, 0);
});

test("送信後receipt保存失敗はleaseを残し、再起動相当のrecent DM scanで二重送信を防ぐ", async (t) => {
  const { store, meeting } = fixture(t);
  prepare(store, meeting);
  let nowMs = 1_000;
  let sendCalls = 0;
  let scanCalls = 0;
  let updateCalls = 0;
  store.db.exec(`
    CREATE TRIGGER reject_initial_invite_receipt
    BEFORE DELETE ON direct_invite_sends
    BEGIN
      SELECT RAISE(ABORT, 'receipt blocked');
    END;
  `);
  const directMessenger = messengerStub({
    findMeetingInviteMessages: async () => {
      scanCalls += 1;
      return scanCalls === 1 ? [] : [{ messageId: "already-visible" }];
    },
    sendMeetingInvite: async ({ beforeSend }) => {
      assert.equal(await beforeSend(), true);
      sendCalls += 1;
      return { messageId: "already-visible" };
    },
    updateMeetingInvite: async ({ messageId, beforeEdit }) => {
      assert.equal(await beforeEdit(), true);
      updateCalls += 1;
      return { messageId };
    },
  });
  const firstScheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger,
    leaseMs: 1_000,
    now: () => nowMs,
    logger: { warn() {}, error() {} },
  });
  const first = await firstScheduler.tick();
  assert.equal(first.failed, 1);
  assert.equal(sendCalls, 1);
  assert.equal(store.getMeetingInvitee(meeting.id, "member-a").deliveryStatus, "pending");

  store.db.exec("DROP TRIGGER reject_initial_invite_receipt");
  nowMs = 2_000;
  const restartedScheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger,
    leaseMs: 1_000,
    now: () => nowMs,
    logger: { warn() {}, error() {} },
  });
  const recovered = await restartedScheduler.tick();
  assert.equal(recovered.sent, 1);
  assert.equal(sendCalls, 1);
  assert.equal(updateCalls, 1);
  assert.equal(store.getMeetingInvitee(meeting.id, "member-a").dmMessageId, "already-visible");
});

test("初回DM送信中の会議更新は古いreceiptを拒否し最新世代がscanで回収する", async (t) => {
  const { store, meeting } = fixture(t);
  prepare(store, meeting);
  const sentTitles = [];
  const recoveredTitles = [];
  const deleted = [];
  let first = true;
  let scanCalls = 0;
  const directMessenger = messengerStub({
    findMeetingInviteMessages: async () => {
      scanCalls += 1;
      return scanCalls === 1 ? [] : [{ messageId: "stale-visible" }];
    },
    sendMeetingInvite: async ({ meeting: claimedMeeting, beforeSend }) => {
      assert.equal(await beforeSend(), true);
      sentTitles.push(claimedMeeting.title);
      if (first) {
        first = false;
        store.updateMeeting(meeting.id, { title: "更新後の会議" });
        return { messageId: "stale-visible" };
      }
      return { messageId: "latest-visible" };
    },
    updateMeetingInvite: async ({ meeting: claimedMeeting, messageId, beforeEdit }) => {
      assert.equal(await beforeEdit(), true);
      recoveredTitles.push(claimedMeeting.title);
      return { messageId };
    },
    deleteDirectMessage: async ({ messageId }) => { deleted.push(messageId); },
  });
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger,
    logger: { warn() {}, error() {} },
  });

  const stale = await scheduler.tick();
  assert.equal(stale.stale, 1);
  const latest = store.getMeeting(meeting.id);
  assert.equal(store.getDirectInviteSendSummary(meeting.id, latest.updatedAtMs).pending, 1);
  assert.deepEqual(deleted, []);

  const repaired = await scheduler.tick();
  assert.equal(repaired.sent, 1);
  assert.deepEqual(sentTitles, ["初回招待テスト"]);
  assert.deepEqual(recoveredTitles, ["更新後の会議"]);
  assert.equal(store.getMeetingInvitee(meeting.id, "member-a").dmMessageId, "stale-visible");
});

test("中止済み会議は初回DMを新規送信せず、残存候補を消してfailedへ閉じる", async (t) => {
  const { store, meeting } = fixture(t);
  prepare(store, meeting);
  const cancelled = store.cancelMeeting(meeting.id);
  let sends = 0;
  let deleted = 0;
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: messengerStub({
      findMeetingInviteMessages: async ({ requireCurrentMember }) => {
        assert.equal(requireCurrentMember, false);
        return [{ messageId: "orphan-visible" }];
      },
      sendMeetingInvite: async () => { sends += 1; return { messageId: "must-not-send" }; },
      deleteDirectMessage: async ({ beforeDelete }) => {
        assert.equal(await beforeDelete(), true);
        deleted += 1;
      },
    }),
    logger: { warn() {}, error() {} },
  });

  const result = await scheduler.tick();
  assert.equal(result.skipped, 1);
  assert.equal(sends, 0);
  assert.equal(deleted, 1);
  const invitee = store.getMeetingInvitee(meeting.id, "member-a");
  assert.equal(invitee.deliveryStatus, "failed");
  assert.equal(invitee.deliveryErrorCode, "meeting_cancelled");
  assert.equal(store.getDirectInviteSendSummary(meeting.id, cancelled.updatedAtMs).unresolved, 0);
});

test("終了時刻後の未送信招待はcompletedへ遷移し新規DMを送らない", async (t) => {
  const { store, meeting } = fixture(t);
  prepare(store, meeting);
  let sends = 0;
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: messengerStub({
      sendMeetingInvite: async () => { sends += 1; return { messageId: "must-not-send" }; },
    }),
    now: () => meeting.endsAtMs + 1,
    logger: { warn() {}, error() {} },
  });
  const result = await scheduler.tick();
  assert.equal(result.skipped, 1);
  assert.equal(sends, 0);
  assert.equal(store.getMeeting(meeting.id).status, "completed");
  assert.equal(store.getMeetingInvitee(meeting.id, "member-a").deliveryErrorCode, "meeting_completed");
});

test("Guild退会者には初回DMを送らず恒久failedにする", async (t) => {
  const { store, meeting } = fixture(t);
  prepare(store, meeting);
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: messengerStub({
      findMeetingInviteMessages: async ({ requireCurrentMember }) => {
        if (requireCurrentMember) throw Object.assign(new Error("departed"), { code: 10007 });
        return [];
      },
      sendMeetingInvite: async () => { throw new Error("must not send"); },
    }),
    logger: { warn() {}, error() {} },
  });
  const result = await scheduler.tick();
  assert.equal(result.skipped, 1);
  assert.equal(store.getMeetingInvitee(meeting.id, "member-a").deliveryStatus, "failed");
  assert.equal(store.getDirectInviteSendSummary(meeting.id).unresolved, 0);
});

test("初回DMの一時障害はbackoff後に再試行する", async (t) => {
  const { store, meeting } = fixture(t);
  prepare(store, meeting);
  let nowMs = 10_000;
  let scans = 0;
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: messengerStub({
      findMeetingInviteMessages: async () => {
        scans += 1;
        if (scans === 1) throw Object.assign(new Error("temporary"), { code: "ETIMEDOUT" });
        return [];
      },
    }),
    now: () => nowMs,
    logger: { warn() {}, error() {} },
  });
  const failed = await scheduler.tick();
  assert.equal(failed.failed, 1);
  const waiting = store.getDirectInviteSendSummary(meeting.id);
  assert.equal(waiting.pending, 1);
  assert.ok(waiting.nextAttemptAtMs > nowMs);
  assert.equal((await scheduler.tick()).claimed, 0);
  nowMs = waiting.nextAttemptAtMs;
  assert.equal((await scheduler.tick()).sent, 1);
});

test("coordinatorは初回DMを直送せず永続schedulerを即時tickする", async (t) => {
  const { store, meeting } = fixture(t);
  const invitee = prepare(store, meeting);
  let ticks = 0;
  let directCalls = 0;
  const coordinator = new MeetingCoordinator({
    client: {},
    store,
    interpreter: { configured: false },
    sheetsSync: null,
    directMessenger: {
      sendMeetingInvite: async () => { directCalls += 1; return { messageId: "wrong-path" }; },
    },
    directInviteUpdateScheduler: {
      tick: async () => {
        ticks += 1;
        store.markInviteeDelivery(meeting.id, invitee.userId, { status: "sent", dmMessageId: "scheduler-path" });
        return { sent: 1 };
      },
    },
    config: {
      guildId: "guild-example",
      timeZone: "Asia/Tokyo",
      creatorRoleIds: [],
      everyoneOffsets: [],
    },
    logger: { warn() {}, error() {} },
  });
  coordinator.refreshMeetingCard = async () => {};
  const result = await coordinator.sendDirectInvites(meeting, [invitee]);
  assert.deepEqual(result, { sent: 1, failed: 0, pending: 0 });
  assert.equal(ticks, 1);
  assert.equal(directCalls, 0);
});

test("recent DM scanは自Botの同一会議customIdだけを候補にする", async () => {
  const memberUser = {
    bot: false,
    system: false,
    createDM: async () => ({
      messages: {
        fetch: async () => new Map([
          ["match", {
            id: "match",
            author: { id: "bot-self" },
            components: [{ components: [{ customId: "meeting:rsvp:SCAN1234:attending" }] }],
          }],
          ["other-author", {
            id: "other-author",
            author: { id: "someone-else" },
            components: [{ components: [{ customId: "meeting:rsvp:SCAN1234:attending" }] }],
          }],
          ["other-meeting", {
            id: "other-meeting",
            author: { id: "bot-self" },
            components: [{ components: [{ customId: "meeting:rsvp:OTHER123:attending" }] }],
          }],
        ]),
      },
    }),
  };
  const messenger = new DiscordDirectMessenger({
    client: {
      user: { id: "bot-self" },
      guilds: {
        fetch: async () => ({
          id: "guild-example",
          members: { fetch: async () => ({ guild: { id: "guild-example" }, user: memberUser }) },
        }),
      },
    },
    guildId: "guild-example",
    buildInvitePayload: () => ({ content: "unused" }),
    buildReminderPayload: () => ({ content: "unused" }),
    logger: { warn() {} },
  });
  assert.deepEqual(await messenger.findMeetingInviteMessages({
    meeting: { id: "SCAN1234", guildId: "guild-example" },
    recipient: { userId: "member-a" },
  }), [{ messageId: "match" }]);
});

test("Discord transportはbeforeSendがstaleならpayloadを外部送信しない", async () => {
  let sends = 0;
  const messenger = new DiscordDirectMessenger({
    client: {
      user: { id: "bot-self" },
      guilds: {
        fetch: async () => ({
          id: "guild-example",
          members: {
            fetch: async () => ({
              guild: { id: "guild-example" },
              user: {
                bot: false,
                system: false,
                send: async () => { sends += 1; return { id: "wrong" }; },
              },
            }),
          },
        }),
      },
    },
    guildId: "guild-example",
    buildInvitePayload: () => ({ content: "private meeting payload" }),
    buildReminderPayload: () => ({ content: "unused" }),
    logger: { warn() {} },
  });
  await assert.rejects(() => messenger.sendMeetingInvite({
    meeting: { id: "FENCE123", guildId: "guild-example" },
    recipient: { userId: "member-a" },
    beforeSend: async () => false,
  }), (error) => error.code === "stale_invite_send");
  assert.equal(sends, 0);
});

test("旧editが最新receipt後に遅着しても現世代jobを再投入して最終表示を自己修復する", async (t) => {
  const { store, meeting } = fixture(t);
  prepare(store, meeting);
  store.markInviteeDelivery(meeting.id, "member-a", { status: "sent", dmMessageId: "existing-dm" });
  const first = store.updateMeeting(meeting.id, { title: "古い編集" });
  let visibleTitle = null;
  let releaseOld;
  let oldStartedResolve;
  const oldStarted = new Promise((resolve) => { oldStartedResolve = resolve; });
  const oldScheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: messengerStub({
      updateMeetingInvite: async ({ meeting: claimedMeeting, beforeEdit, messageId }) => {
        assert.equal(await beforeEdit(), true);
        oldStartedResolve();
        await new Promise((resolve) => { releaseOld = resolve; });
        visibleTitle = claimedMeeting.title;
        return { messageId };
      },
    }),
    logger: { warn() {}, error() {} },
  });
  const oldTick = oldScheduler.tick();
  await oldStarted;

  const latest = store.updateMeeting(first.id, { title: "最新の編集" });
  const latestScheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: messengerStub({
      updateMeetingInvite: async ({ meeting: claimedMeeting, messageId }) => {
        visibleTitle = claimedMeeting.title;
        return { messageId };
      },
    }),
    logger: { warn() {}, error() {} },
  });
  const latestTick = await latestScheduler.tick();
  assert.equal(latestTick.updated, 1);
  assert.equal(visibleTitle, "最新の編集");

  releaseOld();
  const stale = await oldTick;
  assert.equal(stale.stale, 1);
  assert.equal(visibleTitle, "古い編集");
  assert.equal(store.getDirectInviteUpdateSummary(latest.id, latest.updatedAtMs).pending, 1);

  const repaired = await latestScheduler.tick();
  assert.equal(repaired.updated, 1);
  assert.equal(visibleTitle, "最新の編集");
  assert.equal(store.getDirectInviteUpdateSummary(latest.id, latest.updatedAtMs).unresolved, 0);
});

test("cancelは事前read後の競合更新があってもRETURNINGした現世代へoutboxを作る", (t) => {
  const { databasePath, store, meeting } = fixture(t, { meetingId: "CANCEL12", messageId: "card-message" });
  prepare(store, meeting);
  store.markInviteeDelivery(meeting.id, "member-a", { status: "sent", dmMessageId: "existing-dm" });
  const competitor = new MeetingDatabase(databasePath);
  const originalGetMeeting = store.getMeeting.bind(store);
  let raced = false;
  store.getMeeting = (id) => {
    const snapshot = originalGetMeeting(id);
    if (!raced) {
      raced = true;
      competitor.updateMeeting(meeting.id, { title: "競合側の更新" });
    }
    return snapshot;
  };

  const cancelled = store.cancelMeeting(meeting.id);
  store.getMeeting = originalGetMeeting;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cardRevision, 2);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id, cancelled.cardRevision).pending, 1);
  assert.equal(store.getDirectInviteUpdateSummary(meeting.id, cancelled.updatedAtMs).pending, 1);
  competitor.close();
});
