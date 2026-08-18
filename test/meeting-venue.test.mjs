import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
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

test("確認画面のDiscord VCボタンは任意VCの選択メニューを表示する", async () => {
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
    member: { voice: { channelId: null } },
    update: async (payload) => updates.push(payload),
    reply: async () => {},
  }, draft.draftId, "venue-discord");

  assert.equal(draft.meetingUrl, "");
  assert.equal(updates.length, 1);
  assert.match(updates[0].content, /開催するVCを選んで/u);
  assert.equal(updates[0].components[0].toJSON().components[0].channel_types[0], 2);
});

test("選択メニューで指定したVCを保存し自動議事録をONにする", async () => {
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
  const updates = [];
  const selected = {
    id: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    type: ChannelType.GuildVoice,
  };
  await bot.handleDraftVoiceChannelSelect({
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    user: { id: draft.creatorId },
    memberPermissions: { has: () => true },
    values: [VOICE_CHANNEL_ID],
    channels: new Map([[VOICE_CHANNEL_ID, selected]]),
    update: async (payload) => updates.push(payload),
    reply: async () => {},
  }, draft.draftId);

  assert.equal(draft.meetingUrl, `https://discord.com/channels/${GUILD_ID}/${VOICE_CHANNEL_ID}`);
  assert.equal(draft.voiceAutoRecord, true);
  assert.match(updates[0].embeds[0].toJSON().description, /自動議事録:\*\* ON/u);
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
