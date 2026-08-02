import assert from "node:assert/strict";
import test from "node:test";
import { MeetingCoordinator } from "../src/coordinator.mjs";
import {
  discordVoiceChannelUrl,
  meetingVenueFromUrl,
} from "../src/meeting-venue.mjs";

const GUILD_ID = `${"123456789"}${"012345678"}`;
const TEXT_CHANNEL_ID = `${"223456789"}${"012345678"}`;
const VOICE_CHANNEL_ID = `${"323456789"}${"012345678"}`;

function makeCoordinator() {
  return new MeetingCoordinator({
    client: { user: { id: `${"423456789"}${"012345678"}` } },
    store: {},
    interpreter: { configured: false },
    sheetsSync: null,
    meetingUrlResolver: async (url) => url,
    config: {
      guildId: GUILD_ID,
      creatorRoleIds: [],
      defaultDurationMinutes: 60,
      defaultReminders: [30, 0],
      personalDefaultReminders: [60, 10],
    },
  });
}

test("Discord VC・Google Meet・未定を開催場所として判定する", () => {
  const discordUrl = discordVoiceChannelUrl(GUILD_ID, VOICE_CHANNEL_ID);
  assert.equal(meetingVenueFromUrl(discordUrl).type, "discord_voice");
  assert.equal(meetingVenueFromUrl("https://meet.google.com/abc-defg-hij").type, "google_meet");
  assert.equal(meetingVenueFromUrl("").type, "undecided");
});

test("確認画面のDiscord VCボタンは操作した本人が今いるVCを参加先にする", async () => {
  const bot = makeCoordinator();
  const draft = bot.createDraft({
    action: "create",
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    creatorId: `${"523456789"}${"012345678"}`,
    creatorName: "管理者",
    title: "全体MTG",
    startsAtMs: Date.now() + 60_000,
    endsAtMs: Date.now() + 3_660_000,
    reminderMinutes: [30, 0],
    meetingUrl: "",
  });
  const updates = [];
  await bot.handleDraftButton({
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    user: { id: draft.creatorId },
    member: { voice: { channelId: VOICE_CHANNEL_ID } },
    update: async (payload) => updates.push(payload),
    reply: async () => {},
  }, draft.draftId, "venue-discord");

  assert.equal(draft.meetingUrl, `https://discord.com/channels/${GUILD_ID}/${VOICE_CHANNEL_ID}`);
  assert.equal(updates.length, 1);
  assert.match(updates[0].embeds[0].toJSON().description, /Discord VC/u);
});

test("Discord VCボタンはVC未参加なら登録せず短い案内を返す", async () => {
  const bot = makeCoordinator();
  const draft = bot.createDraft({
    action: "create",
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    creatorId: `${"523456789"}${"012345678"}`,
    title: "全体MTG",
    startsAtMs: Date.now() + 60_000,
    endsAtMs: Date.now() + 3_660_000,
    reminderMinutes: [30, 0],
    meetingUrl: "",
  });
  const replies = [];
  await bot.handleDraftButton({
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    user: { id: draft.creatorId },
    member: { voice: { channelId: null } },
    update: async () => {},
    reply: async (payload) => replies.push(payload),
  }, draft.draftId, "venue-discord");

  assert.equal(draft.meetingUrl, "");
  assert.match(replies[0].content, /先に使うVCへ参加/u);
});

test("Google Meetボタンの入力欄からURLを確認画面へ戻せる", async () => {
  const bot = makeCoordinator();
  const creatorId = `${"523456789"}${"012345678"}`;
  const draft = bot.createDraft({
    action: "create",
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    creatorId,
    title: "全体MTG",
    startsAtMs: Date.now() + 60_000,
    endsAtMs: Date.now() + 3_660_000,
    reminderMinutes: [30, 0],
    meetingUrl: "",
  });
  const edits = [];
  await bot.handleDraftUrlModal({
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    user: { id: creatorId },
    memberPermissions: { has: () => true },
    fields: { getTextInputValue: () => "https://meet.google.com/example-room" },
    deferUpdate: async () => {},
    editReply: async (payload) => edits.push(payload),
    followUp: async () => {},
    reply: async () => {},
  }, draft.draftId);

  assert.equal(draft.meetingUrl, "https://meet.google.com/example-room");
  assert.equal(edits.length, 1);
  assert.match(edits[0].embeds[0].toJSON().description, /Google Meet/u);
});
