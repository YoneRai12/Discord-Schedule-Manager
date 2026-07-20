import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("同じ日時と通知時刻の更新は個別DM・出欠・配送状態を一切作り直さない", (t) => {
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

  assert.deepEqual({
    deliveries: readRows("deliveries", "offset_minutes"),
    personalDeliveries: readRows("personal_deliveries", "user_id, offset_minutes"),
    invitees: readRows("meeting_invitees", "user_id"),
    reminders: readRows("meeting_invitee_reminders", "user_id"),
    rsvps: readRows("rsvps", "user_id"),
  }, before);
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
  assert.deepEqual(store.resolveMemberAliases(GUILD_ID, ["メンバーA", "メンバーB"]).missing, ["メンバーB"]);
  assert.throws(() => store.setMemberAlias(GUILD_ID, {
    alias: "メンバーA",
    userId: MEMBER_B_ID,
    displayName: "別人",
    createdById: ADMIN_ID,
  }), /別のメンバー/u);
  assert.equal(store.removeMemberAlias(GUILD_ID, "メンバーA"), true);
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
