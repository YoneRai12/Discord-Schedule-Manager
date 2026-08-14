import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DiscordVoiceReceiver } from "../src/voice/discord-voice-receiver.mjs";

const fakeId = (prefix) => `${prefix}${"234567890"}${"12345678"}`;

function fixture({ consentedUserIds = [], memberIsBot = false } = {}) {
  let joinOptions;
  let createSegmentCalls = 0;
  let subscribeCalls = 0;
  const speaking = new EventEmitter();
  const connection = {
    receiver: {
      speaking,
      subscribe() {
        subscribeCalls += 1;
        return new EventEmitter();
      },
    },
    destroy() {},
  };
  const archive = {
    async createSegment() {
      createSegmentCalls += 1;
      throw new Error("unexpected_segment");
    },
  };
  const voice = {
    EndBehaviorType: { AfterSilence: "silence" },
    VoiceConnectionStatus: { Ready: "ready" },
    async entersState(value) { return value; },
    joinVoiceChannel(options) {
      joinOptions = options;
      return connection;
    },
  };
  const memberId = fakeId(4);
  const voiceChannelId = fakeId(3);
  const guild = {
    id: fakeId(1),
    voiceAdapterCreator: {},
    members: {
      async fetch() {
        return { id: memberId, user: { bot: memberIsBot }, voice: { channelId: voiceChannelId } };
      },
    },
  };
  const receiver = new DiscordVoiceReceiver({ archive, voice });
  return {
    receiver,
    guild,
    voiceChannelId,
    memberId,
    consentedUserIds,
    get joinOptions() { return joinOptions; },
    get createSegmentCalls() { return createSegmentCalls; },
    get subscribeCalls() { return subscribeCalls; },
  };
}

test("Discord VC接続は受信可能・発話不能で開始し、DAVEを無効化しない", async () => {
  const item = fixture();
  await item.receiver.start({
    guild: item.guild,
    voiceChannelId: item.voiceChannelId,
    sessionId: "ABCDEF1234",
    consentedUserIds: [],
  });
  assert.equal(item.joinOptions.selfDeaf, false);
  assert.equal(item.joinOptions.selfMute, true);
  assert.equal(Object.hasOwn(item.joinOptions, "daveEncryption"), false);
  await item.receiver.stop();
});

test("読み上げBotを含むBotユーザーの音声は受信・segment作成しない", async () => {
  const item = fixture({ memberIsBot: true });
  await item.receiver.start({
    guild: item.guild,
    voiceChannelId: item.voiceChannelId,
    sessionId: "ABCDEF1234",
    consentedUserIds: [item.memberId],
  });
  assert.equal(await item.receiver.handleSpeakingStart(item.memberId), false);
  assert.equal(item.createSegmentCalls, 0);
  assert.equal(item.subscribeCalls, 0);
  await item.receiver.stop();
});

test("同意していない利用者の発話はsegment作成前に破棄する", async () => {
  const item = fixture();
  await item.receiver.start({
    guild: item.guild,
    voiceChannelId: item.voiceChannelId,
    sessionId: "ABCDEF1234",
    consentedUserIds: [],
  });
  assert.equal(await item.receiver.handleSpeakingStart(item.memberId), false);
  assert.equal(item.createSegmentCalls, 0);
  assert.equal(item.subscribeCalls, 0);
  await item.receiver.stop();
});
