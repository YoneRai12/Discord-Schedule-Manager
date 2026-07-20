import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MeetingDatabase } from "../src/database.mjs";

const GUILD_ID = "guild-example";
const OTHER_GUILD_ID = "other-guild-example";
const CHANNEL_ID = "channel-example";
const ADMIN_ID = "admin-example";
const BOT_ID = "bot-example";
const MEMBER_A_ID = "member-a";
const MEMBER_B_ID = "member-b";

function withDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-bot-test-"));
  const store = new MeetingDatabase(path.join(root, "meetings.sqlite3"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

function meetingInput(overrides = {}) {
  const startsAtMs = Date.parse("2026-07-20T11:30:00Z");
  return {
    id: "ABCD1234",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    createdById: ADMIN_ID,
    createdByName: "管理者A",
    title: "運営定例",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.example.com/room",
    reminderMinutes: [30, 0],
    everyoneOffsets: [0],
    ...overrides,
  };
}

test("会議・出欠・通知をSQLiteへ再起動可能な形で保存する", (t) => {
  const store = withDatabase(t);
  store.bindTenant({ guildId: GUILD_ID, botUserId: BOT_ID });
  const meeting = store.createMeeting(meetingInput());
  assert.equal(meeting.id, "ABCD1234");
  assert.equal(store.getSnapshot().deliveries.length, 2);

  store.upsertRsvp(meeting.id, {
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
    status: "attending",
  });
  store.upsertRsvp(meeting.id, {
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
    status: "declined",
  });
  const rsvps = store.listRsvps(meeting.id);
  assert.equal(rsvps.length, 1);
  assert.equal(rsvps[0].status, "declined");
});

test("同じDBを別Discordテナントへ流用しない", (t) => {
  const store = withDatabase(t);
  store.bindTenant({ guildId: GUILD_ID, botUserId: BOT_ID });
  assert.throws(() => store.bindTenant({
    guildId: OTHER_GUILD_ID,
    botUserId: BOT_ID,
  }), /一致しません/u);
});

test("privacy照合用active会議ID一覧は表示件数上限を持たない", (t) => {
  const store = withDatabase(t);
  const nowMs = Date.now();
  store.createMeeting(meetingInput({
    id: "ABCDEFGH",
    startsAtMs: nowMs + 60_000,
    endsAtMs: nowMs + 3_600_000,
  }));
  store.createMeeting(meetingInput({
    id: "PAST1234",
    startsAtMs: nowMs - 7_200_000,
    endsAtMs: nowMs - 3_600_000,
  }));
  assert.deepEqual(store.listActiveMeetingIds(GUILD_ID, { nowMs }), ["ABCDEFGH"]);
});

test("通知をトランザクションでclaimし二重送信を防ぐ", (t) => {
  const store = withDatabase(t);
  const nowMs = Date.now();
  store.createMeeting(meetingInput({
    startsAtMs: nowMs,
    endsAtMs: nowMs + 60 * 60_000,
    reminderMinutes: [0],
  }));
  const first = store.claimDueDeliveries({ nowMs, maxLateMinutes: 10 });
  const second = store.claimDueDeliveries({ nowMs, maxLateMinutes: 10 });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(first[0].mentionEveryone, true);

  store.markDeliverySent(first[0].meetingId, first[0].offsetMinutes, { discordMessageId: "777" });
  assert.equal(store.claimDueDeliveries({ nowMs: nowMs + 1_000, maxLateMinutes: 10 }).length, 0);
  assert.equal(store.getSnapshot().deliveries[0].status, "sent");
});

test("送信済み通知を残したまま延期後の同じoffsetを新しい配送世代へ再作成する", (t) => {
  const store = withDatabase(t);
  const startsAtMs = Date.now();
  const meeting = store.createMeeting(meetingInput({
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    reminderMinutes: [0],
  }));
  const [first] = store.claimDueDeliveries({ nowMs: startsAtMs, maxLateMinutes: 10 });
  assert.equal(store.markDeliverySent(meeting.id, 0, {
    scheduleRevision: first.scheduleRevision,
    claimToken: first.claimToken,
    discordMessageId: "old-message",
  }), true);

  const movedStartsAtMs = startsAtMs + 24 * 60 * 60_000;
  const moved = store.updateMeeting(meeting.id, {
    startsAtMs: movedStartsAtMs,
    endsAtMs: movedStartsAtMs + 60 * 60_000,
  });
  const deliveries = store.getSnapshot().deliveries
    .filter((delivery) => delivery.meetingId === meeting.id)
    .sort((a, b) => a.scheduleRevision - b.scheduleRevision);

  assert.equal(moved.scheduleRevision, 1);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries.map((delivery) => ({
    revision: delivery.scheduleRevision,
    status: delivery.status,
    dueAtMs: delivery.dueAtMs,
  })), [
    { revision: 0, status: "sent", dueAtMs: startsAtMs },
    { revision: 1, status: "pending", dueAtMs: movedStartsAtMs },
  ]);
  const [next] = store.claimDueDeliveries({ nowMs: movedStartsAtMs, maxLateMinutes: 10 });
  assert.equal(next.scheduleRevision, 1);
  assert.notEqual(next.claimToken, first.claimToken);
});

test("送信中に延期または中止された古いclaimは現行配送として確定できない", (t) => {
  const store = withDatabase(t);
  const nowMs = Date.now();
  const movedMeeting = store.createMeeting(meetingInput({
    id: "MOVE1234",
    startsAtMs: nowMs,
    endsAtMs: nowMs + 60 * 60_000,
    reminderMinutes: [0],
  }));
  const [oldClaim] = store.claimDueDeliveries({ nowMs, maxLateMinutes: 10 });
  store.updateMeeting(movedMeeting.id, {
    startsAtMs: nowMs + 2 * 60 * 60_000,
    endsAtMs: nowMs + 3 * 60 * 60_000,
  });
  assert.equal(store.isDeliveryClaimCurrent(oldClaim), false);
  assert.equal(store.markDeliverySent(oldClaim.meetingId, oldClaim.offsetMinutes, {
    scheduleRevision: oldClaim.scheduleRevision,
    claimToken: oldClaim.claimToken,
    discordMessageId: "must-not-win",
  }), false);

  const cancelledMeeting = store.createMeeting(meetingInput({
    id: "STOP1234",
    startsAtMs: nowMs,
    endsAtMs: nowMs + 60 * 60_000,
    reminderMinutes: [0],
  }));
  const [cancelledClaim] = store.claimDueDeliveries({ nowMs, maxLateMinutes: 10 });
  store.cancelMeeting(cancelledMeeting.id);
  assert.equal(store.isDeliveryClaimCurrent(cancelledClaim), false);
});

test("個別DMも送信履歴を残して延期後の配送世代を再作成する", (t) => {
  const store = withDatabase(t);
  const startsAtMs = Date.now() + 60 * 60_000;
  const meeting = store.createMeeting(meetingInput({
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
  }));
  store.prepareMeetingInvitees(meeting.id, [{
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
  }], ADMIN_ID, { defaultReminderMinutes: [60] });
  const [first] = store.personalReminders.claimDueDeliveries({ nowMs: startsAtMs - 60 * 60_000 });
  assert.equal(store.personalReminders.markSent(first.id, {
    scheduleRevision: first.scheduleRevision,
    claimToken: first.claimToken,
    discordMessageId: "old-dm",
    sentAtMs: startsAtMs - 60 * 60_000,
  }), true);

  const movedStartsAtMs = startsAtMs + 24 * 60 * 60_000;
  store.updateMeeting(meeting.id, {
    startsAtMs: movedStartsAtMs,
    endsAtMs: movedStartsAtMs + 60 * 60_000,
  });
  const rows = store.personalReminders.listMeetingDeliveries(meeting.id, MEMBER_A_ID)
    .sort((a, b) => a.scheduleRevision - b.scheduleRevision);
  assert.deepEqual(rows.map((row) => ({ revision: row.scheduleRevision, status: row.status })), [
    { revision: 0, status: "sent" },
    { revision: 1, status: "pending" },
  ]);
});

test("送信中に延期された個別DMの古いclaimは新しい配送世代を更新できない", (t) => {
  const store = withDatabase(t);
  const startsAtMs = Date.now() + 60 * 60_000;
  const meeting = store.createMeeting(meetingInput({
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
  }));
  store.prepareMeetingInvitees(meeting.id, [{
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
  }], ADMIN_ID, { defaultReminderMinutes: [60] });
  const [oldClaim] = store.personalReminders.claimDueDeliveries({ nowMs: startsAtMs - 60 * 60_000 });
  const movedStartsAtMs = startsAtMs + 24 * 60 * 60_000;
  store.updateMeeting(meeting.id, {
    startsAtMs: movedStartsAtMs,
    endsAtMs: movedStartsAtMs + 60 * 60_000,
  });

  assert.equal(store.personalReminders.isClaimCurrent(oldClaim), false);
  assert.equal(store.personalReminders.markSent(oldClaim.id, {
    scheduleRevision: oldClaim.scheduleRevision,
    claimToken: oldClaim.claimToken,
    discordMessageId: "must-not-win",
  }), false);
  const rows = store.personalReminders.listMeetingDeliveries(meeting.id, MEMBER_A_ID);
  assert.equal(rows.find((row) => row.scheduleRevision === 0).status, "skipped");
  assert.equal(rows.find((row) => row.scheduleRevision === 1).status, "pending");
});

test("既存DBの配送行を失わず配送世代schemaへ移行する", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-bot-legacy-test-"));
  const databasePath = path.join(root, "meetings.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
      created_by_id TEXT NOT NULL, created_by_name TEXT NOT NULL, title TEXT NOT NULL,
      starts_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL, time_zone TEXT NOT NULL,
      meeting_url TEXT NOT NULL, status TEXT NOT NULL,
      reminder_minutes_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE deliveries (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      offset_minutes INTEGER NOT NULL, due_at_ms INTEGER NOT NULL,
      mention_everyone INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
      lease_expires_at_ms INTEGER, discord_message_id TEXT, last_error_code TEXT, sent_at_ms INTEGER,
      PRIMARY KEY(meeting_id, offset_minutes)
    );
    CREATE TABLE meeting_invitees (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, display_name TEXT NOT NULL, invited_by_id TEXT NOT NULL,
      delivery_status TEXT NOT NULL, delivery_error_code TEXT, dm_message_id TEXT,
      created_at_ms INTEGER NOT NULL, delivered_at_ms INTEGER,
      PRIMARY KEY(meeting_id, user_id)
    );
    CREATE TABLE personal_deliveries (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, user_id TEXT NOT NULL,
      offset_minutes INTEGER NOT NULL, due_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
      lease_expires_at_ms INTEGER, discord_message_id TEXT, last_error_code TEXT,
      sent_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      UNIQUE(meeting_id, user_id, offset_minutes),
      FOREIGN KEY(meeting_id, user_id) REFERENCES meeting_invitees(meeting_id, user_id) ON DELETE CASCADE
    );
  `);
  const input = meetingInput();
  legacy.prepare(`
    INSERT INTO meetings VALUES(?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    input.id, input.guildId, input.channelId, input.createdById, input.createdByName,
    input.title, input.startsAtMs, input.endsAtMs, input.timeZone, input.meetingUrl,
    JSON.stringify(input.reminderMinutes), Date.now(), Date.now(),
  );
  legacy.prepare(`
    INSERT INTO deliveries VALUES(?, 0, ?, 1, 'sent', 1, 0, NULL, 'legacy-message', NULL, ?)
  `).run(input.id, input.startsAtMs, input.startsAtMs);
  legacy.prepare(`
    INSERT INTO meeting_invitees VALUES(?, ?, 'member', ?, 'sent', NULL, 'invite', ?, ?)
  `).run(input.id, MEMBER_A_ID, ADMIN_ID, input.startsAtMs, input.startsAtMs);
  legacy.prepare(`
    INSERT INTO personal_deliveries VALUES(
      'legacy-personal', ?, ?, 60, ?, 'sent', 1, 0, NULL,
      'legacy-dm', NULL, ?, ?, ?
    )
  `).run(
    input.id, MEMBER_A_ID, input.startsAtMs - 60 * 60_000,
    input.startsAtMs - 60 * 60_000, input.startsAtMs, input.startsAtMs,
  );
  legacy.close();

  const store = new MeetingDatabase(databasePath);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(store.getMeeting(input.id).scheduleRevision, 0);
  const [delivery] = store.getSnapshot().deliveries;
  assert.equal(delivery.scheduleRevision, 0);
  assert.equal(delivery.status, "sent");
  assert.equal(delivery.discordMessageId, "legacy-message");
  const [personal] = store.personalReminders.listMeetingDeliveries(input.id, MEMBER_A_ID);
  assert.equal(personal.scheduleRevision, 0);
  assert.equal(personal.status, "sent");
  assert.equal(personal.discordMessageId, "legacy-dm");
});

test("破損した通知JSONは空通知へ読み替えず明示的に拒否する", (t) => {
  const store = withDatabase(t);
  const meeting = store.createMeeting(meetingInput());
  store.db.prepare("UPDATE meetings SET reminder_minutes_json = ? WHERE id = ?")
    .run("{broken", meeting.id);
  assert.throws(
    () => store.getMeeting(meeting.id),
    (error) => error.code === "corrupt_reminder_json",
  );

  const second = store.createMeeting(meetingInput({ id: "JSON1234" }));
  store.prepareMeetingInvitees(second.id, [{
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
  }], ADMIN_ID, { defaultReminderMinutes: [60] });
  store.db.prepare(`
    UPDATE meeting_invitee_reminders SET minutes_json = ?
    WHERE meeting_id = ? AND user_id = ?
  `).run("not-json", second.id, MEMBER_A_ID);
  assert.throws(
    () => store.personalReminders.getMeetingReminders(second.id, MEMBER_A_ID),
    (error) => error.code === "corrupt_reminder_json",
  );
});

test("明示した通知なしは作成と更新の両方で空配列のまま保存する", (t) => {
  const store = withDatabase(t);
  const meeting = store.createMeeting(meetingInput({ reminderMinutes: [] }));
  assert.deepEqual(meeting.reminderMinutes, []);
  assert.equal(store.getSnapshot().deliveries.length, 0);

  const updated = store.updateMeeting(meeting.id, { reminderMinutes: [30, 0] });
  assert.deepEqual(updated.reminderMinutes, [30, 0]);
  assert.equal(store.getSnapshot().deliveries.filter((row) => row.status === "pending").length, 2);
  const disabled = store.updateMeeting(meeting.id, { reminderMinutes: [] });
  assert.deepEqual(disabled.reminderMinutes, []);
  assert.equal(store.getSnapshot().deliveries.filter((row) => row.status === "pending").length, 0);
});

test("updatedAtのCASで古い確認画面からの会議更新とURL更新を拒否する", (t) => {
  const store = withDatabase(t);
  const meeting = store.createMeeting(meetingInput());
  const first = store.updateMeetingIfUnchanged(meeting.id, { title: "新しい会議名" }, {
    expectedUpdatedAtMs: meeting.updatedAtMs,
  });
  assert.equal(first.title, "新しい会議名");
  assert.ok(first.updatedAtMs > meeting.updatedAtMs);
  assert.throws(
    () => store.updateMeetingIfUnchanged(meeting.id, { title: "古い画面の上書き" }, {
      expectedUpdatedAtMs: meeting.updatedAtMs,
    }),
    (error) => error.code === "meeting_update_conflict",
  );
  assert.throws(
    () => store.updateMeetingUrlIfUnchanged(meeting.id, "https://meet.example.com/stale", {
      expectedUpdatedAtMs: meeting.updatedAtMs,
    }),
    (error) => error.code === "meeting_update_conflict",
  );
  const urlUpdated = store.updateMeetingUrlIfUnchanged(meeting.id, "https://meet.example.com/current", {
    expectedUpdatedAtMs: first.updatedAtMs,
  });
  assert.equal(urlUpdated.meetingUrl, "https://meet.example.com/current");
});

test("終了時刻を過ぎた会議をcompletedへ移し以後の出欠を拒否する", (t) => {
  const store = withDatabase(t);
  const nowMs = Date.now();
  const meeting = store.createMeeting(meetingInput({
    startsAtMs: nowMs - 2 * 60 * 60_000,
    endsAtMs: nowMs - 60 * 60_000,
    reminderMinutes: [0],
  }));
  assert.equal(store.completeEndedMeetings({ nowMs }), 1);
  assert.equal(store.getMeeting(meeting.id).status, "completed");
  assert.throws(() => store.upsertRsvp(meeting.id, {
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
    status: "attending",
  }));
  assert.equal(store.getSnapshot().deliveries[0].status, "skipped");
});

test("completed遷移はcardと送信済み招待DMの更新jobも同一transactionへ投入する", (t) => {
  const store = withDatabase(t);
  const nowMs = Date.now();
  const meeting = store.createMeeting(meetingInput({
    id: "DONE1234",
    startsAtMs: nowMs - 2 * 60 * 60_000,
    endsAtMs: nowMs - 60 * 60_000,
    reminderMinutes: [],
    messageId: "meeting-card",
  }));
  store.acknowledgePendingMeetingCardUpdate(meeting.id, meeting.cardRevision);
  store.prepareMeetingInvitees(meeting.id, [{ userId: MEMBER_A_ID, displayName: "メンバーA" }], ADMIN_ID);
  store.markInviteeDelivery(meeting.id, MEMBER_A_ID, { status: "sent", dmMessageId: "invite-dm" });

  assert.equal(store.completeEndedMeetings({ nowMs }), 1);
  const completed = store.getMeeting(meeting.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.cardRevision, meeting.cardRevision + 1);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id, completed.cardRevision).pending, 1);
  assert.equal(store.getDirectInviteUpdateSummary(meeting.id, completed.updatedAtMs).pending, 1);
});

test("初回カードmessageIdと回復jobを会議作成時から同一transactionで保存する", (t) => {
  const store = withDatabase(t);
  const meeting = store.createMeeting(meetingInput({
    id: "CREATE01",
    messageId: "preview-message",
  }));
  assert.equal(meeting.messageId, "preview-message");
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id, meeting.cardRevision).pending, 1);
  assert.equal(store.acknowledgePendingMeetingCardUpdate(meeting.id, meeting.cardRevision), true);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id, meeting.cardRevision).unresolved, 0);
});

test("開始時刻変更と新世代個別通知の再生成は同一transactionでrollbackする", (t) => {
  const store = withDatabase(t);
  const meeting = store.createMeeting(meetingInput({ reminderMinutes: [] }));
  store.prepareMeetingInvitees(meeting.id, [{ userId: MEMBER_A_ID, displayName: "メンバーA" }], ADMIN_ID, {
    defaultReminderMinutes: [60],
  });
  store.db.exec(`
    CREATE TRIGGER reject_new_personal_revision
    BEFORE INSERT ON personal_deliveries
    WHEN NEW.schedule_revision = 1
    BEGIN
      SELECT RAISE(ABORT, 'personal generation blocked');
    END;
  `);
  const moved = meeting.startsAtMs + 24 * 60 * 60_000;
  assert.throws(() => store.updateMeeting(meeting.id, {
    startsAtMs: moved,
    endsAtMs: moved + 60 * 60_000,
  }), /personal generation blocked/u);
  const unchanged = store.getMeeting(meeting.id);
  assert.equal(unchanged.startsAtMs, meeting.startsAtMs);
  assert.equal(unchanged.scheduleRevision, meeting.scheduleRevision);
  assert.equal(
    store.personalReminders.listMeetingDeliveries(meeting.id, MEMBER_A_ID)
      .some((row) => row.scheduleRevision === 1),
    false,
  );
});

test("再起動後は期限切れleaseを新しいclaim tokenで安全に回収する", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-bot-restart-test-"));
  const databasePath = path.join(root, "meetings.sqlite3");
  const nowMs = Date.now();
  let store = new MeetingDatabase(databasePath);
  const meeting = store.createMeeting(meetingInput({
    startsAtMs: nowMs + 60 * 60_000,
    endsAtMs: nowMs + 2 * 60 * 60_000,
    reminderMinutes: [60],
  }));
  store.prepareMeetingInvitees(meeting.id, [{
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
  }], ADMIN_ID, { defaultReminderMinutes: [60] });
  const [groupBefore] = store.claimDueDeliveries({ nowMs, leaseMs: 1_000 });
  const [personalBefore] = store.personalReminders.claimDueDeliveries({ nowMs, leaseMs: 1_000 });
  store.close();

  store = new MeetingDatabase(databasePath);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [groupAfter] = store.claimDueDeliveries({ nowMs: nowMs + 1_001, leaseMs: 1_000 });
  const [personalAfter] = store.personalReminders.claimDueDeliveries({ nowMs: nowMs + 1_001, leaseMs: 1_000 });
  assert.notEqual(groupAfter.claimToken, groupBefore.claimToken);
  assert.notEqual(personalAfter.claimToken, personalBefore.claimToken);
  assert.equal(store.isDeliveryClaimCurrent(groupBefore), false);
  assert.equal(store.personalReminders.isClaimCurrent(personalBefore), false);
});

test("URLだけを更新しても送信済み通知を再生成しない", (t) => {
  const store = withDatabase(t);
  const nowMs = Date.now();
  store.createMeeting(meetingInput({
    startsAtMs: nowMs,
    endsAtMs: nowMs + 60 * 60_000,
    reminderMinutes: [0],
  }));
  const [delivery] = store.claimDueDeliveries({ nowMs, maxLateMinutes: 10 });
  store.markDeliverySent(delivery.meetingId, delivery.offsetMinutes, { discordMessageId: "777" });
  store.updateMeeting("ABCD1234", { meetingUrl: "https://video.example.com/updated-room" });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.meetings[0].meetingUrl, "https://video.example.com/updated-room");
  assert.equal(snapshot.deliveries.length, 1);
  assert.equal(snapshot.deliveries[0].status, "sent");
});

test("URL・会議名更新は送信中のgroupと個別DM claimを無効化し最新payloadで再claimする", (t) => {
  const store = withDatabase(t);
  const nowMs = Date.now();
  const meeting = store.createMeeting(meetingInput({
    startsAtMs: nowMs + 60 * 60_000,
    endsAtMs: nowMs + 2 * 60 * 60_000,
    reminderMinutes: [60],
  }));
  store.prepareMeetingInvitees(meeting.id, [{
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
  }], ADMIN_ID, { defaultReminderMinutes: [60] });
  const [oldGroup] = store.claimDueDeliveries({ nowMs, maxLateMinutes: 10 });
  const [oldPersonal] = store.personalReminders.claimDueDeliveries({ nowMs, maxLateMinutes: 10 });
  assert.equal(store.isDeliveryClaimCurrent(oldGroup), true);
  assert.equal(store.personalReminders.isClaimCurrent(oldPersonal), true);

  const updated = store.updateMeeting(meeting.id, {
    title: "最新の会議名",
    meetingUrl: "https://meet.example.com/latest-room",
  });
  assert.equal(updated.scheduleRevision, meeting.scheduleRevision);
  assert.equal(store.isDeliveryClaimCurrent(oldGroup), false);
  assert.equal(store.personalReminders.isClaimCurrent(oldPersonal), false);
  assert.equal(store.markDeliverySent(oldGroup.meetingId, oldGroup.offsetMinutes, {
    scheduleRevision: oldGroup.scheduleRevision,
    claimToken: oldGroup.claimToken,
    discordMessageId: "stale-group",
  }), false);
  assert.equal(store.personalReminders.markSent(oldPersonal.id, {
    scheduleRevision: oldPersonal.scheduleRevision,
    claimToken: oldPersonal.claimToken,
    discordMessageId: "stale-personal",
  }), false);

  const [newGroup] = store.claimDueDeliveries({ nowMs, maxLateMinutes: 10 });
  const [newPersonal] = store.personalReminders.claimDueDeliveries({ nowMs, maxLateMinutes: 10 });
  assert.notEqual(newGroup.claimToken, oldGroup.claimToken);
  assert.notEqual(newPersonal.claimToken, oldPersonal.claimToken);
  assert.equal(newGroup.title, "最新の会議名");
  assert.equal(newGroup.meetingUrl, "https://meet.example.com/latest-room");
  assert.equal(newPersonal.title, "最新の会議名");
  assert.equal(newPersonal.meetingUrl, "https://meet.example.com/latest-room");
});

test("同じ日時の内容更新は履歴を保ちつつ送信中claimだけ安全に再待機させる", (t) => {
  const store = withDatabase(t);
  const startsAtMs = Date.now() + 2 * 60 * 60_000;
  const meeting = store.createMeeting(meetingInput({
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    reminderMinutes: [30, 0],
  }));
  store.prepareMeetingInvitees(meeting.id, [{
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
  }], ADMIN_ID, { defaultReminderMinutes: [60, 10] });
  store.markInviteeDelivery(meeting.id, MEMBER_A_ID, {
    status: "sent",
    dmMessageId: "invite-message",
  });
  store.upsertRsvp(meeting.id, {
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
    status: "attending",
  });
  store.db.prepare(`
    UPDATE deliveries
    SET status = 'sending', attempts = 2, next_attempt_at_ms = 1234,
        lease_expires_at_ms = 5678, last_error_code = 'retry-test'
    WHERE meeting_id = ? AND offset_minutes = 30
  `).run(meeting.id);
  store.db.prepare(`
    UPDATE personal_deliveries
    SET status = 'sending', attempts = 3, next_attempt_at_ms = 4321,
        lease_expires_at_ms = 8765, last_error_code = 'dm-retry-test'
    WHERE meeting_id = ? AND user_id = ? AND offset_minutes = 60
  `).run(meeting.id, MEMBER_A_ID);

  const readRows = (table, orderBy) => store.db.prepare(
    `SELECT * FROM ${table} WHERE meeting_id = ? ORDER BY ${orderBy}`,
  ).all(meeting.id);
  const before = {
    deliveries: readRows("deliveries", "offset_minutes"),
    personalDeliveries: readRows("personal_deliveries", "user_id, offset_minutes"),
    invitees: readRows("meeting_invitees", "user_id"),
    reminders: readRows("meeting_invitee_reminders", "user_id"),
    rsvps: readRows("rsvps", "user_id"),
  };

  store.updateMeeting(meeting.id, {
    title: "運営定例（URL更新）",
    startsAtMs: meeting.startsAtMs,
    endsAtMs: meeting.endsAtMs,
    meetingUrl: "https://video.example.org/rooms/updated",
    reminderMinutes: [...meeting.reminderMinutes],
  });

  const after = {
    deliveries: readRows("deliveries", "offset_minutes"),
    personalDeliveries: readRows("personal_deliveries", "user_id, offset_minutes"),
    invitees: readRows("meeting_invitees", "user_id"),
    reminders: readRows("meeting_invitee_reminders", "user_id"),
    rsvps: readRows("rsvps", "user_id"),
  };
  assert.deepEqual(after.invitees, before.invitees);
  assert.deepEqual(after.reminders, before.reminders);
  assert.deepEqual(after.rsvps, before.rsvps);
  assert.deepEqual(
    after.deliveries.find((row) => row.offset_minutes === 0),
    before.deliveries.find((row) => row.offset_minutes === 0),
  );
  assert.equal(after.deliveries.find((row) => row.offset_minutes === 30).status, "pending");
  assert.equal(after.deliveries.find((row) => row.offset_minutes === 30).claim_token, null);
  assert.deepEqual(
    after.personalDeliveries.find((row) => row.offset_minutes === 10),
    before.personalDeliveries.find((row) => row.offset_minutes === 10),
  );
  assert.equal(after.personalDeliveries.find((row) => row.offset_minutes === 60).status, "pending");
  assert.equal(after.personalDeliveries.find((row) => row.offset_minutes === 60).claim_token, null);
  assert.equal(store.getMeeting(meeting.id).meetingUrl, "https://video.example.org/rooms/updated");
});

test("呼び名とDiscordユーザーの対応をサーバー内だけで管理する", (t) => {
  const store = withDatabase(t);
  const saved = store.setMemberAlias(GUILD_ID, {
    alias: "メンバーA",
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
    createdById: ADMIN_ID,
  });
  assert.equal(saved.alias, "メンバーA");
  assert.equal(store.getMemberAliasByUserId(GUILD_ID, MEMBER_A_ID).alias, "メンバーA");
  store.setMemberAlias(GUILD_ID, {
    alias: "担当A",
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
    createdById: ADMIN_ID,
  });
  assert.deepEqual(
    store.resolveMemberAliases(GUILD_ID, ["メンバーA", "担当A"]).found.map((item) => item.userId),
    [MEMBER_A_ID, MEMBER_A_ID],
  );
  assert.equal(store.getMemberAliasByUserId(GUILD_ID, MEMBER_A_ID).alias, "担当A");
  assert.deepEqual(store.resolveMemberAliases(GUILD_ID, ["メンバーA", "メンバーB"]).missing, ["メンバーB"]);
  assert.throws(() => store.setMemberAlias(GUILD_ID, {
    alias: "メンバーA",
    userId: MEMBER_B_ID,
    displayName: "別人",
    createdById: ADMIN_ID,
  }), /別のメンバー/u);
  assert.equal(store.removeMemberAlias(GUILD_ID, "メンバーA"), true);
});

test("旧DBの単一呼び名制約を既存データを保ったまま複数呼び名へ移行する", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-alias-migration-"));
  const databasePath = path.join(root, "meetings.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE member_aliases (
      guild_id TEXT NOT NULL,
      alias_key TEXT NOT NULL,
      alias TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_by_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(guild_id, alias_key),
      UNIQUE(guild_id, user_id)
    );
    INSERT INTO member_aliases VALUES(
      '${GUILD_ID}', 'メンバーa', 'メンバーA', '${MEMBER_A_ID}', 'メンバーA', '${ADMIN_ID}', 1, 1
    );
  `);
  legacy.close();

  const store = new MeetingDatabase(databasePath);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.setMemberAlias(GUILD_ID, {
    alias: "担当A",
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
    createdById: ADMIN_ID,
  });
  assert.equal(store.listMemberAliases(GUILD_ID).length, 2);
});

test("個別DMの対象と配信状態を保存し本人の有効な招待だけ検索する", (t) => {
  const store = withDatabase(t);
  const startsAtMs = Date.now() + 60 * 60_000;
  const meeting = store.createMeeting(meetingInput({
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
  }));
  const first = store.prepareMeetingInvitees(meeting.id, [{
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
  }], ADMIN_ID);
  assert.equal(first.prepared.length, 1);
  assert.equal(store.isMeetingInvitee(meeting.id, MEMBER_A_ID), true);

  store.markInviteeDelivery(meeting.id, MEMBER_A_ID, {
    status: "sent",
    dmMessageId: "message-example",
  });
  const duplicate = store.prepareMeetingInvitees(meeting.id, [{
    userId: MEMBER_A_ID,
    displayName: "メンバーA",
  }], ADMIN_ID);
  assert.equal(duplicate.prepared.length, 0);
  assert.equal(duplicate.alreadySent.length, 1);
  assert.equal(store.listOpenInvitationsForUser(MEMBER_A_ID, { nowMs: startsAtMs - 1 }).length, 1);
  assert.equal(store.listOpenInvitationsForUser(MEMBER_B_ID, { nowMs: startsAtMs - 1 }).length, 0);
});
