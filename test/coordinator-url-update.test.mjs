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
const REPLACEMENT_URL = "https://meet.google.com/example-room";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-url-update-"));
  const store = new MeetingDatabase(path.join(root, "meetings.sqlite3"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

function createMeeting(store, {
  id,
  title,
  messageId = null,
  createdById = ADMIN_ID,
  startsAtMs = Date.now() + 2 * 60 * 60_000,
} = {}) {
  const meeting = store.createMeeting({
    id,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    createdById,
    createdByName: "管理者A",
    title,
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.example.com/original-room",
    reminderMinutes: [30, 0],
    everyoneOffsets: [0],
  });
  if (messageId) store.setMessageId(meeting.id, messageId);
  return store.getMeeting(meeting.id);
}

function makeMessage({ replies, reference = null } = {}) {
  return {
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    author: { id: ADMIN_ID, username: "管理者A" },
    member: { permissions: { has: () => true } },
    mentions: { users: new Map() },
    reference,
    reply: async (payload) => {
      replies.push(payload);
      return { id: `preview-${replies.length}` };
    },
  };
}

function makeCoordinator(store, { meetingUrlResolver, interpretation = null } = {}) {
  const aiInputs = [];
  const bot = new MeetingCoordinator({
    client: { user: { id: "bot-example", toString: () => "@Bot" } },
    store,
    interpreter: {
      configured: true,
      interpret: async (input) => {
        aiInputs.push(input);
        if (interpretation) return interpretation;
        throw new Error("ローカルURL更新でAIを呼び出してはいけません");
      },
    },
    sheetsSync: { requestSync() {} },
    config: {
      guildId: GUILD_ID,
      defaultDurationMinutes: 60,
      defaultReminders: [30, 0],
      personalDefaultReminders: [60, 10],
      everyoneOffsets: [0],
      creatorRoleIds: [],
    },
    meetingUrlResolver,
    logger: { warn() {}, error() {} },
  });
  return { bot, aiInputs };
}

async function requestUrlUpdate(bot, text, { reference = null } = {}) {
  const replies = [];
  await bot.handleMention(makeMessage({ replies, reference }), text);
  return { replies, drafts: [...bot.drafts.values()] };
}

function assertUrlUpdateDraft(draft, meetingId) {
  assert.equal(draft.action, "update");
  assert.equal(draft.meetingId, meetingId);
  assert.equal(draft.meetingUrl, REPLACEMENT_URL);
  assert.equal(draft.urlOnly, true);
}

test("明示したlegacy 7文字IDのURL差し替えをAIなしでdraft化する", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "ABC1234", title: "全体定例" });
  createMeeting(store, { id: "MEET0001", title: "別の定例" });
  const { bot, aiInputs } = makeCoordinator(store);

  const result = await requestUrlUpdate(
    bot,
    `meeting url id:ABC1234 url:${REPLACEMENT_URL}`,
  );

  assert.equal(aiInputs.length, 0);
  assert.equal(result.drafts.length, 1);
  assertUrlUpdateDraft(result.drafts[0], "ABC1234");
  assert.equal(JSON.stringify(aiInputs).includes(REPLACEMENT_URL), false);
  assert.equal(JSON.stringify(aiInputs).includes("ABC1234"), false);
});

test("会議名から複数候補中の1件を選んでURL差し替えdraftを作る", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "MEET0001", title: "全体定例", createdById: "other-admin-a" });
  createMeeting(store, { id: "MEET0002", title: "設計定例", createdById: "other-admin-b" });
  const { bot, aiInputs } = makeCoordinator(store);

  const result = await requestUrlUpdate(
    bot,
    `設計定例のリンクを ${REPLACEMENT_URL} に変更して`,
  );

  assert.equal(aiInputs.length, 0);
  assert.equal(result.drafts.length, 1);
  assertUrlUpdateDraft(result.drafts[0], "MEET0002");
});

test("返信した会議カードのmessageIdからURL差し替え対象を決める", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "MEET0001", title: "全体定例", messageId: "card-one", createdById: "other-admin-a" });
  createMeeting(store, { id: "MEET0002", title: "設計定例", messageId: "card-two", createdById: "other-admin-b" });
  const { bot, aiInputs } = makeCoordinator(store);

  const result = await requestUrlUpdate(
    bot,
    `このリンクにして ${REPLACEMENT_URL}`,
    { reference: { messageId: "card-two", channelId: CHANNEL_ID, guildId: GUILD_ID } },
  );

  assert.equal(aiInputs.length, 0);
  assert.equal(result.drafts.length, 1);
  assertUrlUpdateDraft(result.drafts[0], "MEET0002");
});

test("チャンネル内の有効な会議が1件だけならIDなしでもURL差し替えdraftを作る", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "MEET0001", title: "全体定例", createdById: "other-admin" });
  const { bot, aiInputs } = makeCoordinator(store);

  const result = await requestUrlUpdate(bot, `このリンクにして ${REPLACEMENT_URL}`);

  assert.equal(aiInputs.length, 0);
  assert.equal(result.drafts.length, 1);
  assertUrlUpdateDraft(result.drafts[0], "MEET0001");
});

test("開催予定が1件ならURLを貼るだけで差し替えdraftを作る", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "MEET0001", title: "全体定例", createdById: "other-admin" });
  const { bot, aiInputs } = makeCoordinator(store);

  const result = await requestUrlUpdate(bot, REPLACEMENT_URL);

  assert.equal(aiInputs.length, 0);
  assert.equal(result.drafts.length, 1);
  assertUrlUpdateDraft(result.drafts[0], "MEET0001");
});

test("定型文にない自然な言い回しは伏せ字化してAIで意図判定し、対象照合はローカルで行う", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "MEET0001", title: "全体定例", createdById: "other-admin" });
  const { bot, aiInputs } = makeCoordinator(store, {
    interpretation: {
      action: "update",
      meetingId: null,
      title: null,
      startsAtMs: null,
      durationMinutes: 60,
      reminderMinutes: [30, 0],
      providedFields: ["meetingUrl"],
      missingFields: [],
      confidence: 0.94,
      clarification: null,
    },
  });

  const result = await requestUrlUpdate(
    bot,
    `さっき話してたやつ、こっちでお願い ${REPLACEMENT_URL}`,
  );

  assert.equal(aiInputs.length, 1);
  assert.equal(aiInputs[0].hasMeetingUrl, true);
  assert.equal(aiInputs[0].sanitizedText.includes("[URL_REDACTED]"), true);
  assert.equal(aiInputs[0].sanitizedText.includes("https://"), false);
  assert.equal(JSON.stringify(aiInputs).includes(REPLACEMENT_URL), false);
  assert.equal(result.drafts.length, 1);
  assertUrlUpdateDraft(result.drafts[0], "MEET0001");
});

test("会議名・日時・固定メンバー・URLを順不同で混ぜても作成候補へ整理する", async (t) => {
  const store = fixture(t);
  for (const [alias, userId] of [["メンバーA", "member-a"], ["メンバーB", "member-b"], ["メンバーC", "member-c"]]) {
    store.setMemberAlias(GUILD_ID, { alias, userId, displayName: alias, createdById: ADMIN_ID });
  }
  const startsAtMs = Date.parse("2026-07-21T10:00:00.000Z");
  const { bot, aiInputs } = makeCoordinator(store, {
    interpretation: {
      action: "create",
      meetingId: null,
      title: "全体MTG",
      startsAtMs,
      durationMinutes: 60,
      reminderMinutes: [30, 0],
      providedFields: ["title", "startsAt", "meetingUrl"],
      missingFields: [],
      confidence: 0.97,
      clarification: null,
    },
  });

  const result = await requestUrlUpdate(
    bot,
    `メンバーAとメンバーBで ${REPLACEMENT_URL} 全体MTG メンバーC 7月21日19時`,
  );

  assert.equal(aiInputs.length, 1);
  assert.equal(aiInputs[0].sanitizedText.includes(REPLACEMENT_URL), false);
  for (const alias of ["メンバーA", "メンバーB", "メンバーC"]) {
    assert.equal(aiInputs[0].sanitizedText.includes(alias), false);
  }
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].action, "create");
  assert.equal(result.drafts[0].title, "全体MTG");
  assert.equal(result.drafts[0].startsAtMs, startsAtMs);
  assert.deepEqual(
    new Set(result.drafts[0].invitees.map((item) => item.userId)),
    new Set(["member-a", "member-b", "member-c"]),
  );
});

test("会議名だけ無い場合は日時から仮名を付け、確認画面で自動設定と分かる", async (t) => {
  const store = fixture(t);
  const startsAtMs = Date.parse("2026-07-21T10:00:00.000Z");
  const { bot } = makeCoordinator(store, {
    interpretation: {
      action: "create",
      meetingId: null,
      title: null,
      startsAtMs,
      durationMinutes: 60,
      reminderMinutes: [30, 0],
      providedFields: ["startsAt", "meetingUrl"],
      missingFields: ["title"],
      confidence: 0.9,
      clarification: null,
    },
  });

  const result = await requestUrlUpdate(bot, `7月21日19時 ${REPLACEMENT_URL}`);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].title, "会議 7/21 19:00");
  assert.equal(result.drafts[0].autoTitle, true);
  assert.match(result.replies[0].embeds[0].data.description, /自動設定/u);
});

test("必須項目が足りないときは不足している項目名だけを返す", async (t) => {
  const store = fixture(t);
  const { bot } = makeCoordinator(store, {
    interpretation: {
      action: "create",
      meetingId: null,
      title: "全体MTG",
      startsAtMs: null,
      durationMinutes: 60,
      reminderMinutes: [30, 0],
      providedFields: ["title", "meetingUrl"],
      missingFields: ["startsAt"],
      confidence: 0.9,
      clarification: null,
    },
  });

  const result = await requestUrlUpdate(bot, `全体MTG ${REPLACEMENT_URL}`);
  assert.equal(result.drafts.length, 0);
  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0].content, /足りない項目: \*\*開始日時\*\*/u);
  assert.doesNotMatch(result.replies[0].content, /会議名・開始日時・会議URL/u);
});

test("AIへ回る曖昧入力でも内部会議IDとURLを送らない", async (t) => {
  const store = fixture(t);
  const { bot, aiInputs } = makeCoordinator(store, {
    interpretation: {
      action: "unknown",
      meetingId: null,
      title: null,
      startsAtMs: null,
      durationMinutes: 60,
      reminderMinutes: [30, 0],
      providedFields: ["meetingUrl"],
      missingFields: [],
      confidence: 0.3,
      clarification: "操作内容を教えてください。",
    },
  });

  await requestUrlUpdate(bot, `ABC1234 いい感じにお願い ${REPLACEMENT_URL}`);
  assert.equal(aiInputs.length, 1);
  assert.equal(aiInputs[0].sanitizedText.includes("ABC1234"), false);
  assert.match(aiInputs[0].sanitizedText, /\[MEETING_ID\]/u);
  assert.equal(JSON.stringify(aiInputs).includes(REPLACEMENT_URL), false);
});

test("ID・会議名・返信先がなく候補が複数ならURL差し替えを実行しない", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "MEET0001", title: "全体定例", createdById: "other-admin-a" });
  createMeeting(store, { id: "MEET0002", title: "設計定例", createdById: "other-admin-b" });
  const { bot, aiInputs } = makeCoordinator(store);

  const result = await requestUrlUpdate(bot, `このリンクにして ${REPLACEMENT_URL}`);

  assert.equal(aiInputs.length, 0);
  assert.equal(result.drafts.length, 0);
  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0].content, /会議ID|会議名|返信/u);
  assert.equal(JSON.stringify(aiInputs).includes(REPLACEMENT_URL), false);
});

test("Googleカレンダー招待URLはローカルでMeet URLへ解決し、AIへ一切送らない", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "ABC1234", title: "全体定例" });
  const invitationUrl = "https://calendar.app.google/example-invitation";
  const resolverCalls = [];
  const { bot, aiInputs } = makeCoordinator(store, {
    meetingUrlResolver: async (url) => {
      resolverCalls.push(url);
      return REPLACEMENT_URL;
    },
  });

  const result = await requestUrlUpdate(
    bot,
    `ABC1234のリンクを ${invitationUrl} に差し替えて`,
  );

  assert.deepEqual(resolverCalls, [invitationUrl]);
  assert.equal(result.drafts.length, 1);
  assertUrlUpdateDraft(result.drafts[0], "ABC1234");
  assert.equal(aiInputs.length, 0);
  assert.equal(JSON.stringify(aiInputs).includes(invitationUrl), false);
  assert.equal(JSON.stringify(aiInputs).includes(REPLACEMENT_URL), false);
});

test("異なる会議URLと既知サービスのルートURLは拒否し、任意HTTPS会議URLは許可する", async (t) => {
  const store = fixture(t);
  const { bot } = makeCoordinator(store);
  await assert.rejects(
    bot.resolveSubmittedMeetingUrl([
      "https://meet.google.com/room-one",
      "https://us02web.zoom.us/j/123456789",
    ]),
    /複数/u,
  );
  assert.equal(
    await bot.resolveSubmittedMeetingUrl(["https://video.example.org/rooms/team-review"]),
    "https://video.example.org/rooms/team-review",
  );
  await assert.rejects(
    bot.resolveSubmittedMeetingUrl(["https://meet.google.com/"]),
    /確認できません/u,
  );
});

test("保存済み招待URLの修復はlegacy ID・通知配送・出欠を変えずURLだけ更新する", async (t) => {
  const store = fixture(t);
  const invitationUrl = "https://calendar.app.google/legacy-invitation";
  const meeting = createMeeting(store, {
    id: "ABC1234",
    title: "全体定例",
  });
  store.updateMeetingUrl(meeting.id, invitationUrl);
  store.upsertRsvp(meeting.id, {
    userId: "member-a",
    displayName: "メンバーA",
    status: "attending",
  });
  const before = store.getSnapshot();
  const resolverCalls = [];
  const { bot, aiInputs } = makeCoordinator(store, {
    meetingUrlResolver: async (url) => {
      resolverCalls.push(url);
      return REPLACEMENT_URL;
    },
  });
  bot.refreshMeetingCard = async () => {};

  const result = await bot.repairActiveInvitationUrls();
  const after = store.getSnapshot();

  assert.deepEqual(result, { repaired: 1, failed: 0, skippedByDeadline: 0 });
  assert.deepEqual(resolverCalls, [invitationUrl]);
  assert.equal(store.getMeeting("ABC1234").id, "ABC1234");
  assert.equal(store.getMeeting("ABC1234").meetingUrl, REPLACEMENT_URL);
  assert.deepEqual(after.rsvps, before.rsvps);
  assert.deepEqual(after.deliveries, before.deliveries);
  assert.equal(aiInputs.length, 0);
  assert.equal(JSON.stringify(aiInputs).includes(invitationUrl), false);
  assert.equal(JSON.stringify(aiInputs).includes(REPLACEMENT_URL), false);
});

test("URLだけの確認確定では通知配送・試行状態・出欠を作り直さない", async (t) => {
  const store = fixture(t);
  const meeting = createMeeting(store, { id: "MEET0001", title: "全体定例" });
  const firstDelivery = store.getSnapshot().deliveries[0];
  store.markDeliverySent(meeting.id, firstDelivery.offsetMinutes, { discordMessageId: "sent-message" });
  store.upsertRsvp(meeting.id, { userId: "member-a", displayName: "メンバーA", status: "attending" });
  const before = store.getSnapshot();
  const { bot } = makeCoordinator(store);
  bot.refreshMeetingCard = async () => {};
  const edits = [];

  await bot.confirmUpdate({ editReply: async (payload) => { edits.push(payload); } }, {
    action: "update",
    meetingId: meeting.id,
    meetingUrl: REPLACEMENT_URL,
    title: meeting.title,
    startsAtMs: meeting.startsAtMs,
    endsAtMs: meeting.endsAtMs,
    reminderMinutes: meeting.reminderMinutes,
    urlOnly: true,
  });

  const after = store.getSnapshot();
  assert.equal(store.getMeeting(meeting.id).meetingUrl, REPLACEMENT_URL);
  assert.deepEqual(after.deliveries, before.deliveries);
  assert.deepEqual(after.rsvps, before.rsvps);
  assert.equal(edits.length, 1);
});
