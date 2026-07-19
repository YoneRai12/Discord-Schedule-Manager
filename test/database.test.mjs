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
