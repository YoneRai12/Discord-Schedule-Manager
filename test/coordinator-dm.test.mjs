import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MeetingCoordinator } from "../src/coordinator.mjs";
import { MeetingDatabase } from "../src/database.mjs";

const GUILD_ID = "guild-example";
const CHANNEL_ID = "channel-example";
const ADMIN_ID = "admin-example";
const MEMBER_ID = "member-a";
const BOT_ID = "bot-example";

test("招待された本人のDM回答をAIへ渡さず出欠へ保存する", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-bot-dm-test-"));
  const store = new MeetingDatabase(path.join(root, "meetings.sqlite3"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now();
  const meeting = store.createMeeting({
    id: "ABCD1234",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    createdById: ADMIN_ID,
    createdByName: "管理者",
    title: "運営定例",
    startsAtMs: now + 60 * 60_000,
    endsAtMs: now + 2 * 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.example.com/room",
    reminderMinutes: [30, 0],
    everyoneOffsets: [0],
  });
  store.prepareMeetingInvitees(meeting.id, [{ userId: MEMBER_ID, displayName: "メンバーA" }], ADMIN_ID);

  let aiCalls = 0;
  let refreshes = 0;
  let replyText = "";
  const coordinator = new MeetingCoordinator({
    client: { user: { id: BOT_ID } },
    store,
    interpreter: { configured: true, interpret: async () => { aiCalls += 1; } },
    sheetsSync: { requestSync() {} },
    config: { guildId: GUILD_ID },
    logger: { warn() {}, error() {} },
  });
  coordinator.refreshMeetingCard = async () => { refreshes += 1; };
  await coordinator.handleDirectMessage({
    author: { id: MEMBER_ID, username: "member-a", bot: false },
    content: "参加します",
    reply: async ({ content }) => { replyText = content; },
  });

  assert.equal(aiCalls, 0);
  assert.equal(refreshes, 1);
  assert.equal(store.listRsvps(meeting.id)[0].status, "attending");
  assert.match(replyText, /参加/u);
});

test("自然言語登録でもURL・Discord ID・登録済み呼び名をAI入力から外す", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-bot-privacy-test-"));
  const store = new MeetingDatabase(path.join(root, "meetings.sqlite3"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.setMemberAlias(GUILD_ID, {
    alias: "メンバーA",
    userId: MEMBER_ID,
    displayName: "メンバーA",
    createdById: ADMIN_ID,
  });
  let aiInput = null;
  const coordinator = new MeetingCoordinator({
    client: { user: { id: BOT_ID } },
    store,
    interpreter: {
      configured: true,
      interpret: async (input) => {
        aiInput = input;
        return { action: "unknown", clarification: "確認できませんでした", missingFields: [] };
      },
    },
    sheetsSync: null,
    config: { guildId: GUILD_ID },
    logger: { warn() {}, error() {} },
  });
  await coordinator.handleMention({
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    author: { id: ADMIN_ID, username: "manager", bot: false },
    member: { permissions: { has: () => true } },
    mentions: { users: new Map() },
    reply: async () => ({}),
  }, "明日20時から運営定例。URL: https://meet.example.com/room\n参加者: メンバーA");

  assert.equal(aiInput.hasMeetingUrl, true);
  assert.equal(aiInput.sanitizedText.includes("https://"), false);
  assert.equal(aiInput.sanitizedText.includes("メンバーA"), false);
  assert.equal(aiInput.sanitizedText.includes(MEMBER_ID), false);
});
