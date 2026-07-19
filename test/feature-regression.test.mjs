import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MeetingDatabase } from "../src/database.mjs";
import { resolveParticipantSnapshot } from "../src/participant-resolution.mjs";
import { SelfServiceController } from "../src/self-service-controller.mjs";

const GUILD_ID = "guild-example";
const CHANNEL_ID = "channel-example";
const ADMIN_ID = "admin-example";

function withDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-feature-regression-"));
  const store = new MeetingDatabase(path.join(root, "meetings.sqlite3"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

function createMeeting(store, {
  id,
  startsAtMs = Date.now() + 2 * 60 * 60_000,
  meetingUrl = "https://example.com/meeting",
} = {}) {
  return store.createMeeting({
    id,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    createdById: ADMIN_ID,
    createdByName: "管理者A",
    title: "定例会議",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl,
    reminderMinutes: [30, 0],
    everyoneOffsets: [0],
  });
}

function memberSnapshot(members) {
  return members
    .map(({ userId, displayName }) => ({ userId, displayName }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

function makeController(store) {
  return new SelfServiceController({
    store,
    guildId: GUILD_ID,
    refreshMeetingCard: async () => {},
    sheetsSync: { requestSync() {} },
    logger: { warn() {} },
  });
}

test("15人の既定テンプレートを更新しても作成済み会議の参加者スナップショットは変わらない", (t) => {
  const store = withDatabase(t);
  const labels = "ABCDEFGHIJKLMNO";
  const originalMembers = [...labels].map((label, index) => ({
    userId: `member-${String(index + 1).padStart(2, "0")}`,
    displayName: `メンバー${label}`,
  }));

  const saved = store.attendanceTemplates.saveTemplate(GUILD_ID, {
    name: "全体定例",
    members: originalMembers,
    createdById: ADMIN_ID,
    makeDefault: true,
    nowMs: 1_000,
  });
  assert.equal(saved.isDefault, true);
  assert.equal(saved.members.length, 15);
  assert.equal(store.attendanceTemplates.getDefaultTemplate(GUILD_ID).name, "全体定例");

  const resolved = resolveParticipantSnapshot({ defaultTemplate: saved });
  const meetingSnapshot = memberSnapshot(resolved.invitees);
  assert.equal(resolved.source, "default_template");
  assert.equal(resolved.templateName, "全体定例");

  const meeting = createMeeting(store, { id: "MEET0001" });
  store.prepareMeetingInvitees(meeting.id, resolved.invitees, ADMIN_ID);

  store.attendanceTemplates.saveTemplate(GUILD_ID, {
    name: "全体定例",
    members: originalMembers.slice(0, 2),
    createdById: ADMIN_ID,
    makeDefault: true,
    nowMs: 2_000,
  });

  assert.equal(store.attendanceTemplates.getDefaultTemplate(GUILD_ID).members.length, 2);
  assert.deepEqual(memberSnapshot(resolved.invitees), meetingSnapshot);
  assert.deepEqual(memberSnapshot(store.listMeetingInvitees(meeting.id)), meetingSnapshot);
});

test("個人通知60分前と10分前を保存し、欠席時はskip、参加へ戻すと再生成する", async (t) => {
  const store = withDatabase(t);
  const startsAtMs = Date.now() + 3 * 60 * 60_000;
  const meeting = createMeeting(store, {
    id: "MEET0002",
    startsAtMs,
    meetingUrl: "https://example.com/meeting/two",
  });
  const userId = "member-a";

  const preference = store.personalReminders.setMemberPreference(GUILD_ID, userId, [60, 10], { nowMs: 1_000 });
  assert.deepEqual(preference.minutes, [60, 10]);
  store.prepareMeetingInvitees(meeting.id, [{ userId, displayName: "メンバーA" }], ADMIN_ID);

  assert.deepEqual(store.personalReminders.getMeetingReminders(meeting.id, userId).minutes, [60, 10]);
  assert.deepEqual(
    store.personalReminders.listMeetingDeliveries(meeting.id, userId).map((item) => item.offsetMinutes),
    [60, 10],
  );

  store.upsertRsvp(meeting.id, { userId, displayName: "メンバーA", status: "declined" });
  const claimedWhileDeclined = store.personalReminders.claimDueDeliveries({
    nowMs: startsAtMs - 60 * 60_000,
    maxLateMinutes: 10,
  });
  assert.deepEqual(claimedWhileDeclined, []);
  const skipped = store.personalReminders.listMeetingDeliveries(meeting.id, userId);
  assert.deepEqual(skipped.map((item) => item.status), ["skipped", "skipped"]);
  assert.deepEqual(skipped.map((item) => item.lastErrorCode), ["rsvp_declined", "rsvp_declined"]);

  const replies = [];
  await makeController(store).handleMessage({
    author: { id: userId, username: "member-a" },
    content: "MEET0002 参加します",
    reply: async (payload) => { replies.push(payload); },
  }, { privateReply: true });

  assert.equal(store.listRsvps(meeting.id)[0].status, "attending");
  const regenerated = store.personalReminders.listMeetingDeliveries(meeting.id, userId);
  assert.deepEqual(regenerated.map((item) => item.offsetMinutes), [60, 10]);
  assert.deepEqual(regenerated.map((item) => item.status), ["pending", "pending"]);
  assert.match(replies[0].content, /確認しました/u);
});

test("DMの自然言語回答を確認し、公開チャンネル返信には会議URLを含めない", async (t) => {
  const store = withDatabase(t);
  const meetingUrl = "https://example.com/meeting/three";
  const meeting = createMeeting(store, { id: "MEET0003", meetingUrl });
  const userId = "member-b";
  store.prepareMeetingInvitees(
    meeting.id,
    [{ userId, displayName: "メンバーB" }],
    ADMIN_ID,
    { defaultReminderMinutes: [60, 10] },
  );
  const controller = makeController(store);

  const directReplies = [];
  const directHandled = await controller.handleMessage({
    author: { id: userId, username: "member-b" },
    content: "参加します。1時間前と10分前に通知して",
    reply: async (payload) => { directReplies.push(payload); },
  }, { privateReply: true });

  assert.equal(directHandled, true);
  assert.match(directReplies[0].content, /確認しました/u);
  assert.equal(directReplies[0].embeds[0].toJSON().title, "✅ 確認しました");
  assert.equal(store.listRsvps(meeting.id)[0].status, "attending");
  assert.deepEqual(store.personalReminders.getMeetingReminders(meeting.id, userId).minutes, [60, 10]);

  const publicReplies = [];
  const publicHandled = await controller.handleMessage({
    author: { id: userId, username: "member-b" },
    content: `MEET0003 今回は参加します`,
    reply: async (payload) => { publicReplies.push(payload); },
  }, { privateReply: false, requireExplicitTarget: true });

  assert.equal(publicHandled, true);
  assert.match(publicReplies[0].content, /確認しました/u);
  assert.doesNotMatch(JSON.stringify(publicReplies[0]), /https:\/\/example\.com/u);
  assert.equal(JSON.stringify(publicReplies[0]).includes(meetingUrl), false);
});
