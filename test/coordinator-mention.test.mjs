import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatMeetingListContent, MeetingCoordinator } from "../src/coordinator.mjs";
import { MeetingDatabase } from "../src/database.mjs";

const GUILD_ID = "guild-example";

test("会議一覧はDiscordの本文上限内に収め、残件数を表示する", () => {
  const meetings = Array.from({ length: 20 }, (_, index) => ({
    id: `LIST${String(index).padStart(4, "0")}`,
    title: "長い会議名".repeat(20),
    startsAtMs: Date.now() + index * 60_000,
  }));
  const content = formatMeetingListContent(meetings);
  assert.ok(content.length <= 1_900);
  assert.match(content, /…ほか\d+件/u);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-mention-test-"));
  const store = new MeetingDatabase(path.join(root, "meetings.sqlite3"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

function message({ authorId = "admin-example", manager = true, replies = [] } = {}) {
  return {
    guildId: GUILD_ID,
    channelId: "channel-example",
    author: { id: authorId, username: "ユーザー" },
    member: { permissions: { has: () => manager } },
    mentions: { users: new Map() },
    reply: async (payload) => {
      replies.push(payload);
      return { id: `reply-${replies.length}` };
    },
  };
}

function coordinator(store, interpreter) {
  return new MeetingCoordinator({
    client: { user: { id: "bot-example", toString: () => "@Bot" } },
    store,
    interpreter,
    sheetsSync: { requestSync() {} },
    config: {
      guildId: GUILD_ID,
      defaultDurationMinutes: 60,
      defaultReminders: [30, 0],
      personalDefaultReminders: [60, 10],
      everyoneOffsets: [0],
      creatorRoleIds: [],
    },
    logger: { warn() {}, error() {} },
  });
}

test("通常チャンネルの自然言語会議作成は既定テンプレートを使い、URLとテンプレート名をAIへ送らない", async (t) => {
  const store = fixture(t);
  store.attendanceTemplates.saveTemplate(GUILD_ID, {
    name: "全体定例",
    members: [
      { userId: "member-a", displayName: "メンバーA" },
      { userId: "member-b", displayName: "メンバーB" },
    ],
    createdById: "admin-example",
    makeDefault: true,
  });
  const aiInputs = [];
  const bot = coordinator(store, {
    configured: true,
    interpret: async (input) => {
      aiInputs.push(input);
      return {
        action: "create",
        title: "全体定例",
        startsAtMs: Date.now() + 60 * 60_000,
        durationMinutes: 60,
        reminderMinutes: [30, 0],
        missingFields: [],
      };
    },
  });
  const replies = [];
  await bot.handleMention(
    message({ replies }),
    "明日20時から全体定例を登録。URL: https://meet.google.com/example-meeting",
  );

  assert.equal(aiInputs.length, 1);
  assert.equal(aiInputs[0].sanitizedText.includes("https://"), false);
  const [draft] = bot.drafts.values();
  assert.equal(draft.participantSource, "default_template");
  assert.equal(draft.templateName, "全体定例");
  assert.deepEqual(draft.invitees.map((item) => item.displayName), ["メンバーA", "メンバーB"]);

  aiInputs.length = 0;
  await bot.handleMention(
    message({ replies }),
    "明日21時から別の会議。参加者テンプレート: 全体定例 URL: https://meet.google.com/other-meeting",
  );
  assert.equal(aiInputs.length, 1);
  assert.equal(aiInputs[0].sanitizedText.includes("全体定例"), false);
});

test("一般メンバーも@Botで自分の出欠を回答でき、公開返信へURLを再掲しない", async (t) => {
  const store = fixture(t);
  const start = Date.now() + 60 * 60_000;
  const meetingRecord = store.createMeeting({
    id: "MEET0001",
    guildId: GUILD_ID,
    channelId: "channel-example",
    createdById: "admin-example",
    createdByName: "管理者A",
    title: "全体定例",
    startsAtMs: start,
    endsAtMs: start + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://example.com/private-meeting",
    reminderMinutes: [30, 0],
    everyoneOffsets: [0],
  });
  store.prepareMeetingInvitees(
    meetingRecord.id,
    [{ userId: "member-a", displayName: "メンバーA" }],
    "admin-example",
    { defaultReminderMinutes: [60, 10] },
  );
  let aiCalls = 0;
  const bot = coordinator(store, {
    configured: true,
    interpret: async () => { aiCalls += 1; },
  });
  bot.refreshMeetingCard = async () => {};
  const replies = [];
  await bot.handleMention(
    message({ authorId: "member-a", manager: false, replies }),
    "MEET0001の会議に参加します",
  );

  assert.equal(aiCalls, 0);
  assert.equal(store.listRsvps("MEET0001")[0].status, "attending");
  assert.match(replies[0].content, /確認しました/u);
  assert.equal(JSON.stringify(replies[0]).includes("https://example.com/private-meeting"), false);
});
