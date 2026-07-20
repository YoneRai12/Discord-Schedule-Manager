import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PermissionFlagsBits } from "discord.js";
import { MeetingCoordinator } from "../src/coordinator.mjs";
import { MeetingDatabase } from "../src/database.mjs";

const GUILD_ID = "guild-example";
const PUBLIC_CHANNEL = "channel-public";
const PRIVATE_CHANNEL = "channel-private";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-security-regression-"));
  const store = new MeetingDatabase(path.join(root, "meetings.sqlite3"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}

function createMeeting(store, { id, channelId = PUBLIC_CHANNEL, invitees = [] }) {
  const startsAtMs = Date.now() + 60 * 60_000;
  const meeting = store.createMeeting({
    id,
    guildId: GUILD_ID,
    channelId,
    createdById: "admin",
    createdByName: "管理者",
    title: channelId === PRIVATE_CHANNEL ? "非公開役員会" : "公開定例",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.google.com/example-room",
    reminderMinutes: [30, 0],
    everyoneOffsets: [0],
  });
  if (invitees.length) store.prepareMeetingInvitees(meeting.id, invitees, "admin");
  return store.getMeeting(meeting.id);
}

function makeBot(store, { interpreter = { configured: false }, directMessenger = null } = {}) {
  const client = {
    user: { id: "bot", toString: () => "@Bot" },
    channels: {
      fetch: async (channelId) => ({
        id: channelId,
        permissionsFor: (member) => ({
          has: (permission) => permission === PermissionFlagsBits.ViewChannel
            ? !(channelId === PRIVATE_CHANNEL && member?.id === "outsider")
            : true,
        }),
      }),
    },
    guilds: {
      fetch: async () => ({ members: { fetch: async (id) => ({ id }) } }),
    },
  };
  return new MeetingCoordinator({
    client,
    store,
    interpreter,
    directMessenger,
    sheetsSync: { requestSync() {} },
    config: {
      guildId: GUILD_ID,
      timeZone: "Asia/Tokyo",
      defaultDurationMinutes: 60,
      defaultReminders: [30, 0],
      personalDefaultReminders: [60, 10],
      everyoneOffsets: [0],
      creatorRoleIds: [],
    },
    logger: { warn() {}, error() {} },
  });
}

function subject({ id = "outsider", channelId = PUBLIC_CHANNEL, manager = false, replies = [] } = {}) {
  return {
    guildId: GUILD_ID,
    channelId,
    author: { id, username: id },
    user: { id, username: id },
    member: { id, permissions: { has: () => manager } },
    memberPermissions: { has: () => manager },
    mentions: { users: new Map() },
    reply: async (payload) => { replies.push(payload); return { id: `reply-${replies.length}` }; },
  };
}

test("一覧と状況は元チャンネルを見られる会議だけ返す（@mention/slash）", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "PUBLIC01" });
  createMeeting(store, { id: "PRIVATE1", channelId: PRIVATE_CHANNEL });
  const bot = makeBot(store);

  const mentionReplies = [];
  await bot.handleMention(subject({ replies: mentionReplies }), "会議一覧を見せて");
  assert.match(mentionReplies[0].content, /PUBLIC01/u);
  assert.doesNotMatch(mentionReplies[0].content, /PRIVATE1|非公開役員会/u);

  const slashReplies = [];
  const interaction = {
    ...subject(),
    options: { getString: () => "PRIVATE1" },
    reply: async (payload) => { slashReplies.push(payload); },
  };
  await bot.commandList(interaction);
  assert.match(slashReplies[0].content, /PUBLIC01/u);
  assert.doesNotMatch(slashReplies[0].content, /PRIVATE1/u);
  await bot.commandStatus(interaction);
  assert.match(slashReplies[1].content, /見つかりません/u);
});

test("非公開会議は別チャンネルから更新・招待・中止できない", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "PRIVATE1", channelId: PRIVATE_CHANNEL });
  const bot = makeBot(store);

  const naturalReplies = [];
  await bot.handleMention(
    subject({ id: "creator-role-user", manager: true, replies: naturalReplies }),
    "PRIVATE1を中止して",
  );
  assert.equal(store.getMeeting("PRIVATE1").status, "active");
  assert.match(naturalReplies[0].content, /見つかりません/u);

  const slashReplies = [];
  await bot.commandCancel({
    ...subject({ id: "outsider", manager: true }),
    options: { getString: () => "PRIVATE1" },
    reply: async (payload) => slashReplies.push(payload),
  });
  assert.equal(store.getMeeting("PRIVATE1").status, "active");
  assert.match(slashReplies[0].content, /見つかりません/u);
});

test("固定招待者がいる会議は対象者だけRSVPでき、開放会議は従来どおり", async (t) => {
  const store = fixture(t);
  createMeeting(store, {
    id: "FIXED001",
    invitees: [{ userId: "member-a", displayName: "メンバーA" }],
  });
  createMeeting(store, { id: "OPEN0001" });
  const bot = makeBot(store);
  bot.refreshMeetingCard = async () => {};

  const invoke = async (meetingId, userId) => {
    const edits = [];
    await bot.handleRsvp({
      guildId: GUILD_ID,
      user: { id: userId, username: userId },
      member: { displayName: userId },
      deferReply: async () => {},
      editReply: async (payload) => { edits.push(payload); },
    }, meetingId, "attending");
    return edits;
  };

  const rejected = await invoke("FIXED001", "outsider");
  assert.match(rejected[0].content, /招待されたメンバーだけ/u);
  assert.equal(store.listRsvps("FIXED001").length, 0);
  await invoke("FIXED001", "member-a");
  await invoke("OPEN0001", "outsider");
  assert.equal(store.listRsvps("FIXED001").length, 1);
  assert.equal(store.listRsvps("OPEN0001").length, 1);
});

test("退会者は過去のDMボタンから出欠を変更できない", async (t) => {
  const store = fixture(t);
  createMeeting(store, {
    id: "DMLEAVE1",
    invitees: [{ userId: "former-member", displayName: "退会者" }],
  });
  let cardRefreshes = 0;
  const bot = makeBot(store, {
    directMessenger: {
      currentHumanMember: async () => {
        throw Object.assign(new Error("not a member"), { code: "not_guild_member" });
      },
    },
  });
  bot.refreshMeetingCard = async () => { cardRefreshes += 1; };
  const edits = [];
  await bot.handleRsvp({
    guildId: null,
    user: { id: "former-member", username: "former-member" },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  }, "DMLEAVE1", "attending");
  assert.equal(store.listRsvps("DMLEAVE1").length, 0);
  assert.equal(cardRefreshes, 0);
  assert.match(edits[0].content, /更新できません/u);
});

test("confirm時に権限・guild・channelを再検証する", async (t) => {
  const store = fixture(t);
  const bot = makeBot(store);
  const draft = bot.createDraft({
    action: "create",
    guildId: GUILD_ID,
    channelId: PUBLIC_CHANNEL,
    creatorId: "former-admin",
  });
  const replies = [];
  await bot.handleDraftButton({
    guildId: GUILD_ID,
    channelId: PUBLIC_CHANNEL,
    user: { id: "former-admin" },
    memberPermissions: { has: () => false },
    reply: async (payload) => { replies.push(payload); },
  }, draft.draftId, "confirm");
  assert.match(replies[0].content, /権限がない/u);
});

test("再起動後などで失効した確認ボタンは元メッセージから除去する", async (t) => {
  const store = fixture(t);
  const bot = makeBot(store);
  const updates = [];
  await bot.handleDraftButton({
    update: async (payload) => updates.push(payload),
  }, "missing-draft", "confirm");
  assert.match(updates[0].content, /期限切れ/u);
  assert.deepEqual(updates[0].components, []);
});

test("更新確認中に会議が変わったら古いdraftを適用しない", async (t) => {
  const store = fixture(t);
  const meeting = createMeeting(store, { id: "RACE0001" });
  const bot = makeBot(store);
  const draft = bot.buildUpdateDraft({
    interpretation: {
      meetingId: meeting.id,
      title: "新タイトル",
      startsAtMs: null,
      durationMinutes: 60,
      reminderMinutes: [30, 0],
      providedFields: ["title"],
    },
    meetingUrl: null,
    guildId: GUILD_ID,
    channelId: PUBLIC_CHANNEL,
    creatorId: "admin",
    creatorName: "管理者",
  });
  store.updateMeeting(meeting.id, { startsAtMs: meeting.startsAtMs + 60_000, endsAtMs: meeting.endsAtMs + 60_000 });
  await assert.rejects(bot.confirmUpdate({ editReply: async () => {} }, draft), /確認中に会議内容が変更/u);
  assert.equal(store.getMeeting(meeting.id).title, meeting.title);
});

test("複数会議IDはAIへ送る前にローカルで停止する", async (t) => {
  const store = fixture(t);
  let aiCalls = 0;
  const bot = makeBot(store, { interpreter: { configured: true, interpret: async () => { aiCalls += 1; } } });
  const replies = [];
  await bot.handleMention(subject({ manager: true, replies }), "ID: ABCD2345 ではなく ID: EFGH6789 を更新");
  assert.equal(aiCalls, 0);
  assert.match(replies[0].content, /会議IDが複数/u);
});

test("一覧表示上限外でも実在する全英字小文字IDをAI本文から除去する", async (t) => {
  const store = fixture(t);
  createMeeting(store, { id: "ABCDEFGH" });
  // 表示用queryに依存すると101件目以降が漏れるため、空を返す状況を再現する。
  store.listUpcoming = () => [];
  let aiInput = null;
  const bot = makeBot(store, {
    interpreter: {
      configured: true,
      interpret: async (input) => {
        aiInput = input;
        return { action: "unknown", clarification: "確認できませんでした", missingFields: [] };
      },
    },
  });
  await bot.handleMention(subject({ id: "admin", manager: true }), "meeting abcdefgh update");
  assert.ok(aiInput);
  assert.equal(aiInput.sanitizedText.includes("abcdefgh"), false);
  assert.match(aiInput.sanitizedText, /MEETING_ID/u);
});

test("呼び名一覧などの管理情報は公開チャンネルではなく管理者DMへ返す", async (t) => {
  const store = fixture(t);
  store.setMemberAlias(GUILD_ID, {
    alias: "固定メンバー",
    userId: "member-example",
    displayName: "表示名",
    createdById: "admin",
  });
  const bot = makeBot(store);
  const publicReplies = [];
  const directMessages = [];
  const message = subject({ id: "admin", manager: true, replies: publicReplies });
  message.author.send = async (payload) => { directMessages.push(payload); };

  await bot.handleNaturalManagerCommand(
    message,
    "呼び名一覧を見せて",
    { action: "member_list" },
    async (content) => publicReplies.push({ content }),
  );

  assert.equal(directMessages.length, 1);
  assert.match(directMessages[0].content, /固定メンバー/u);
  assert.deepEqual(directMessages[0].allowedMentions, { parse: [], repliedUser: false });
  assert.equal(publicReplies.length, 1);
  assert.match(publicReplies[0].content, /DMに送りました/u);
  assert.doesNotMatch(publicReplies[0].content, /固定メンバー|表示名/u);
});

test("日時・URL変更と中止を既存の招待DMへ反映する", async (t) => {
  const store = fixture(t);
  const meeting = createMeeting(store, {
    id: "DMEDIT01",
    invitees: [{ userId: "member-a", displayName: "メンバーA" }],
  });
  store.markInviteeDelivery(meeting.id, "member-a", { status: "sent", dmMessageId: "dm-message" });
  const updates = [];
  const bot = makeBot(store, {
    directMessenger: {
      sendMeetingInvite: async () => ({ messageId: "unused" }),
      updateMeetingInvite: async (input) => { updates.push(input); return { messageId: input.messageId }; },
    },
  });
  bot.refreshMeetingCard = async () => {};
  const draft = bot.buildUpdateDraft({
    interpretation: {
      meetingId: meeting.id,
      title: null,
      startsAtMs: meeting.startsAtMs + 30 * 60_000,
      durationMinutes: 60,
      reminderMinutes: meeting.reminderMinutes,
      providedFields: ["startsAt", "meetingUrl"],
    },
    meetingUrl: "https://meet.google.com/updated-room",
    guildId: GUILD_ID,
    channelId: PUBLIC_CHANNEL,
    creatorId: "admin",
    creatorName: "管理者",
  });
  await bot.confirmUpdate({ editReply: async () => {} }, draft);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].meeting.meetingUrl, "https://meet.google.com/updated-room");
  assert.equal(updates[0].meeting.startsAtMs, draft.startsAtMs);

  const replies = [];
  await bot.handleNaturalManagerCommand(
    subject({ id: "admin", manager: true, replies }),
    "DMEDIT01を中止",
    { action: "meeting_cancel", meetingId: "DMEDIT01" },
    async (content) => replies.push({ content }),
  );
  assert.equal(updates.length, 2);
  assert.equal(updates[1].meeting.status, "cancelled");
});

test("会議カード表示に失敗した作成はactiveのまま残さない", async (t) => {
  const store = fixture(t);
  const bot = makeBot(store);
  const startsAtMs = Date.now() + 60 * 60_000;
  await assert.rejects(bot.confirmCreate({
    channel: {
      permissionsFor: () => ({ has: () => true }),
    },
    message: { id: "preview-message" },
    editReply: async () => { throw Object.assign(new Error("discord unavailable"), { code: "discord_unavailable" }); },
  }, {
    guildId: GUILD_ID,
    channelId: PUBLIC_CHANNEL,
    creatorId: "admin",
    creatorName: "管理者",
    title: "表示失敗会議",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    meetingUrl: "https://meet.google.com/example-room",
    reminderMinutes: [30, 0],
    invitees: [],
  }), /discord unavailable/u);
  assert.equal(store.listUpcoming(GUILD_ID).length, 0);
  assert.equal(store.getSnapshot().meetings[0].status, "cancelled");
});
