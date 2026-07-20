import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MeetingCoordinator } from "../src/coordinator.mjs";
import { MeetingDatabase } from "../src/database.mjs";
import { DirectInviteUpdateScheduler } from "../src/direct-invite-update-scheduler.mjs";
import { DiscordDirectMessenger } from "../src/discord-direct-messenger.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "direct-invite-update-"));
  const store = new MeetingDatabase(path.join(root, "meetings.sqlite3"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const startsAtMs = Date.now() + 60 * 60_000;
  const meeting = store.createMeeting({
    id: "DMUP1234",
    guildId: "guild-example",
    channelId: "channel-example",
    createdById: "admin-example",
    createdByName: "管理者",
    title: "更新テスト",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.example.com/old",
    reminderMinutes: [30, 0],
    everyoneOffsets: [0],
  });
  store.prepareMeetingInvitees(meeting.id, [{ userId: "former-member", displayName: "退会済みの人" }], "admin-example");
  store.markInviteeDelivery(meeting.id, "former-member", { status: "sent", dmMessageId: "dm-message" });
  return { store, meeting };
}

test("招待DM更新outboxはURLを保存せず、再起動後もclaimできる", (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, { meetingUrl: "https://meet.example.com/private-new" });
  assert.equal(store.getDirectInviteUpdateSummary(updated.id, updated.updatedAtMs).pending, 1);

  const columns = store.db.prepare("PRAGMA table_info(direct_invite_updates)").all().map((row) => row.name);
  assert.equal(columns.some((name) => /url/i.test(name)), false);
  const [claim] = store.claimDirectInviteUpdates({ nowMs: Date.now(), leaseMs: 1_000 });
  assert.equal(claim.meeting.meetingUrl, "https://meet.example.com/private-new");
  assert.equal(claim.userId, "former-member");
  assert.equal(store.isDirectInviteUpdateClaimCurrent(claim), true);
});

test("期限切れleaseはDB再起動後に新しいclaim tokenで回収する", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "direct-invite-restart-"));
  const databasePath = path.join(root, "meetings.sqlite3");
  let store = new MeetingDatabase(databasePath);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const startsAtMs = Date.now() + 60 * 60_000;
  const meeting = store.createMeeting({
    id: "REST1234",
    guildId: "guild-example",
    channelId: "channel-example",
    createdById: "admin-example",
    createdByName: "管理者",
    title: "再起動テスト",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.example.com/restart",
    reminderMinutes: [],
    everyoneOffsets: [],
  });
  store.prepareMeetingInvitees(meeting.id, [{ userId: "former-member", displayName: "対象者" }], "admin-example");
  store.markInviteeDelivery(meeting.id, "former-member", { status: "sent", dmMessageId: "dm-message" });
  const updated = store.updateMeeting(meeting.id, { title: "再起動後に反映" });
  store.queueDirectInviteUpdates(updated.id, { targetUpdatedAtMs: updated.updatedAtMs, nowMs: 1_000 });
  const [first] = store.claimDirectInviteUpdates({ nowMs: 1_000, leaseMs: 1_000 });
  store.close();

  store = new MeetingDatabase(databasePath);
  assert.deepEqual(store.claimDirectInviteUpdates({ nowMs: 1_999, leaseMs: 1_000 }), []);
  const [recovered] = store.claimDirectInviteUpdates({ nowMs: 2_000, leaseMs: 1_000 });
  assert.notEqual(recovered.claimToken, first.claimToken);
  assert.equal(recovered.meeting.title, "再起動後に反映");
});

test("新しい更新は古いclaimを無効化し、古い成功記録を拒否する", (t) => {
  const { store, meeting } = fixture(t);
  const first = store.updateMeeting(meeting.id, { title: "一回目" });
  store.queueDirectInviteUpdates(first.id, { targetUpdatedAtMs: first.updatedAtMs });
  const [oldClaim] = store.claimDirectInviteUpdates({ nowMs: Date.now() });

  const second = store.updateMeeting(first.id, { title: "二回目" });
  store.queueDirectInviteUpdates(second.id, { targetUpdatedAtMs: second.updatedAtMs });
  assert.equal(store.isDirectInviteUpdateClaimCurrent(oldClaim), false);
  assert.equal(store.markDirectInviteUpdateSucceeded(oldClaim), false);
  const [newClaim] = store.claimDirectInviteUpdates({ nowMs: Date.now() });
  assert.equal(newClaim.targetUpdatedAtMs, second.updatedAtMs);
  assert.equal(newClaim.meeting.title, "二回目");
});

test("中止状態も送信済み招待者へ反映対象としてqueueする", (t) => {
  const { store, meeting } = fixture(t);
  const cancelled = store.cancelMeeting(meeting.id);
  assert.equal(store.getDirectInviteUpdateSummary(cancelled.id, cancelled.updatedAtMs).pending, 1);
  const [claim] = store.claimDirectInviteUpdates({ nowMs: Date.now() });
  assert.equal(claim.meeting.status, "cancelled");
});

test("会議更新と招待DM outbox投入は同一transactionで確定する", (t) => {
  const { store, meeting } = fixture(t);
  store.db.exec(`
    CREATE TRIGGER reject_direct_invite_outbox
    BEFORE INSERT ON direct_invite_updates
    BEGIN
      SELECT RAISE(ABORT, 'outbox blocked');
    END;
  `);
  assert.throws(
    () => store.updateMeeting(meeting.id, {
      title: "保存されてはいけない更新",
      meetingUrl: "https://meet.example.com/must-rollback",
    }),
    /outbox blocked/u,
  );
  const unchanged = store.getMeeting(meeting.id);
  assert.equal(unchanged.title, meeting.title);
  assert.equal(unchanged.meetingUrl, meeting.meetingUrl);
});

test("schedulerは既存招待DMを更新し、恒久失敗はskip、通常障害はbackoffする", async (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, { meetingUrl: "https://meet.example.com/new" });
  store.queueDirectInviteUpdates(updated.id, { targetUpdatedAtMs: updated.updatedAtMs });
  const calls = [];
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: {
      updateMeetingInvite: async (input) => {
        calls.push(input);
        assert.equal(await input.beforeEdit(), true);
        return { messageId: input.messageId };
      },
    },
    now: () => updated.updatedAtMs + 1,
    logger: { warn() {}, error() {} },
  });
  const result = await scheduler.tick();
  assert.deepEqual({ claimed: result.claimed, updated: result.updated, failed: result.failed }, { claimed: 1, updated: 1, failed: 0 });
  assert.equal(calls[0].recipient.userId, "former-member");
  assert.equal(store.getDirectInviteUpdateSummary(updated.id, updated.updatedAtMs).unresolved, 0);

  const next = store.updateMeeting(updated.id, { title: "恒久失敗" });
  store.queueDirectInviteUpdates(next.id, { targetUpdatedAtMs: next.updatedAtMs });
  scheduler.directMessenger.updateMeetingInvite = async () => { throw Object.assign(new Error("unknown"), { code: 10008 }); };
  const permanent = await scheduler.tick();
  assert.equal(permanent.skipped, 1);
  assert.equal(store.getDirectInviteUpdateSummary(next.id, next.updatedAtMs).unresolved, 0);

  const retry = store.updateMeeting(next.id, { title: "一時障害" });
  store.queueDirectInviteUpdates(retry.id, { targetUpdatedAtMs: retry.updatedAtMs });
  scheduler.directMessenger.updateMeetingInvite = async () => { throw Object.assign(new Error("temporary"), { code: "ETIMEDOUT" }); };
  const transient = await scheduler.tick();
  assert.equal(transient.failed, 1);
  const state = store.getDirectInviteUpdateSummary(retry.id, retry.updatedAtMs);
  assert.equal(state.pending, 1);
  assert.ok(state.nextAttemptAtMs > retry.updatedAtMs + 1);
});

test("通常障害も上限回数に達したらskipして無限再試行しない", async (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, { title: "retry上限" });
  store.queueDirectInviteUpdates(updated.id, { targetUpdatedAtMs: updated.updatedAtMs });
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: { updateMeetingInvite: async () => { throw Object.assign(new Error("temporary"), { code: "ETIMEDOUT" }); } },
    maxAttempts: 1,
    logger: { warn() {}, error() {} },
  });
  const result = await scheduler.tick();
  assert.equal(result.skipped, 1);
  assert.equal(store.getDirectInviteUpdateSummary(updated.id, updated.updatedAtMs).unresolved, 0);
});

test("退会者には新URL payloadを作らず旧DMを削除してjobを完了する", async (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, { meetingUrl: "https://meet.example.com/member-only-new" });
  let payloadBuilds = 0;
  let deletions = 0;
  const directMessenger = new DiscordDirectMessenger({
    client: {
      guilds: {
        fetch: async () => ({
          id: "guild-example",
          members: {
            fetch: async () => { throw Object.assign(new Error("departed"), { code: 10007 }); },
          },
        }),
      },
      users: {
        fetch: async () => ({
          bot: false,
          system: false,
          createDM: async () => ({
            messages: {
              fetch: async () => ({
                id: "dm-message",
                delete: async () => { deletions += 1; },
              }),
            },
          }),
        }),
      },
    },
    guildId: "guild-example",
    buildInvitePayload: () => {
      payloadBuilds += 1;
      return { content: "URLを含むため退会者向けには作らない" };
    },
    buildReminderPayload: () => ({ content: "unused" }),
    logger: { warn() {} },
  });
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger,
    logger: { warn() {}, error() {} },
  });
  const result = await scheduler.tick();
  assert.equal(result.updated, 1);
  assert.equal(payloadBuilds, 0);
  assert.equal(deletions, 1);
  assert.equal(store.getDirectInviteUpdateSummary(updated.id, updated.updatedAtMs).unresolved, 0);
});

test("stopAndDrainは進行中tickの完了を待つ", async (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, { title: "drain" });
  store.queueDirectInviteUpdates(updated.id, { targetUpdatedAtMs: updated.updatedAtMs });
  let release;
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: { updateMeetingInvite: () => new Promise((resolve) => { release = resolve; }) },
    intervalSeconds: 60,
    logger: { warn() {}, error() {} },
  });
  const tick = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const drain = scheduler.stopAndDrain(1_000);
  release({ messageId: "dm-message" });
  assert.equal(await drain, true);
  await tick;
});

test("coordinatorは永続queueを即時tickし、未反映人数を返す", async (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, { title: "coordinator統合" });
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger: { updateMeetingInvite: async () => ({ messageId: "dm-message" }) },
    logger: { warn() {}, error() {} },
  });
  const coordinator = new MeetingCoordinator({
    client: {},
    store,
    interpreter: { configured: false },
    sheetsSync: null,
    directMessenger: scheduler.directMessenger,
    directInviteUpdateScheduler: scheduler,
    config: {
      guildId: "guild-example",
      timeZone: "Asia/Tokyo",
      creatorRoleIds: [],
      everyoneOffsets: [0],
    },
    logger: { warn() {}, error() {} },
  });
  const result = await coordinator.refreshExistingDirectInvites(updated);
  assert.deepEqual(
    { queued: result.queued, updated: result.updated, failed: result.failed, pending: result.pending },
    { queued: 1, updated: 1, failed: 0, pending: 0 },
  );
});

test("DM edit後にreceiptがstaleでも新世代jobを残し次tickで最新状態へ自己修復する", async (t) => {
  const { store, meeting } = fixture(t);
  const first = store.updateMeeting(meeting.id, { title: "最初の更新" });
  const editedTitles = [];
  const directMessenger = {
    updateMeetingInvite: async ({ meeting: claimedMeeting, beforeEdit, messageId }) => {
      assert.equal(await beforeEdit(), true);
      editedTitles.push(claimedMeeting.title);
      store.updateMeeting(first.id, {
        title: "edit中に確定した最新更新",
        meetingUrl: "https://meet.example.com/latest-after-edit",
      });
      return { messageId };
    },
  };
  const scheduler = new DirectInviteUpdateScheduler({
    store,
    directMessenger,
    logger: { warn() {}, error() {} },
  });
  const stale = await scheduler.tick();
  assert.equal(stale.stale, 1);
  const latest = store.getMeeting(first.id);
  assert.equal(store.getDirectInviteUpdateSummary(latest.id, latest.updatedAtMs).pending, 1);

  directMessenger.updateMeetingInvite = async ({ meeting: claimedMeeting, messageId }) => {
    editedTitles.push(claimedMeeting.title);
    return { messageId };
  };
  const repaired = await scheduler.tick();
  assert.equal(repaired.updated, 1);
  assert.deepEqual(editedTitles, ["最初の更新", "edit中に確定した最新更新"]);
});
