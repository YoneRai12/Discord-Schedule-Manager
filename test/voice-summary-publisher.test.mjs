import assert from "node:assert/strict";
import test from "node:test";
import { VoiceSummaryPublisher } from "../src/voice/voice-summary-publisher.mjs";

const fakeId = (prefix) => `${prefix}${"234567890"}${"12345678"}`;
const guildId = fakeId(1);
const channelId = fakeId(2);
const wrongGuildId = fakeId(9);

function mockDiscord({ actualGuildId = guildId } = {}) {
  const sent = [];
  const channel = {
    id: channelId,
    guildId: actualGuildId,
    isTextBased: () => true,
    async send(payload) {
      sent.push(payload);
      return { id: String(BigInt(fakeId(3)) + BigInt(sent.length)) };
    },
  };
  const guild = {
    id: actualGuildId,
    channels: { async fetch(id) { return id === channelId ? channel : null; } },
  };
  const client = { guilds: { async fetch() { return guild; } } };
  return { client, sent };
}

function rawTranscript() {
  return {
    language: "ja-JP",
    segments: [{
      speakerId: guildId,
      speakerName: "登録名",
      startMs: 0,
      endMs: 1_000,
      text: `登録名: <@${guildId}> @everyone user@example.com`,
    }],
  };
}

function analysis(overrides = {}) {
  return {
    aiUsed: true,
    factCheckUsed: true,
    minutes: {
      overview: "@everyone に通知せず概要を共有する。",
      topics: ["テスト"],
      decisions: [],
      actionItems: [],
      openQuestions: [],
      publicClaims: [],
    },
    factChecks: [{
      claim: "公開情報の主張",
      verdict: "verified",
      summary: "確認済み。",
      sources: [{ title: "公開資料", url: "https://example.com/report" }],
    }],
    ...overrides,
  };
}

test("publisherはメンションを無効化し、発言者名付きtext Bufferだけを添付してaudioを送らない", async () => {
  const { client, sent } = mockDiscord();
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });
  const audio = Buffer.from("not-audio-for-discord");
  const result = await publisher.publish({
    session: { guildId, outputChannelId: channelId, audio, audioPath: "C:\\private\\meeting.wav" },
    transcript: rawTranscript(),
    analysis: analysis(),
  });

  assert.equal(result.channelId, channelId);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.doesNotMatch(sent[0].content, /@everyone|@here|<@/u);
  assert.match(sent[0].content, /<https:\/\/example\.com\/report>/u);
  assert.equal(sent[0].files.length, 1);
  assert.equal(sent[0].files[0].name, "voice-transcript.txt");
  assert.ok(Buffer.isBuffer(sent[0].files[0].attachment));
  assert.notEqual(sent[0].files[0].attachment, audio);
  const attachedText = sent[0].files[0].attachment.toString("utf8");
  assert.match(attachedText, /speaker-01/u);
  assert.match(attachedText, /登録名/u);
  assert.match(attachedText, /user@example\.com/u);
  assert.doesNotMatch(attachedText, /@everyone|<@/u);
  assert.doesNotMatch(attachedText, /meeting\.wav/u);
  assert.equal(attachedText.includes(guildId), false);
});

test("publisherは別guild・別channelを送信前に拒否する", async () => {
  const { client, sent } = mockDiscord();
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });
  await assert.rejects(
    publisher.publish({
      session: { guildId: wrongGuildId, outputChannelId: channelId },
      transcript: rawTranscript(),
      analysis: analysis(),
    }),
    (error) => error.code === "voice_summary_guild_mismatch",
  );
  assert.equal(sent.length, 0);

  const wrongGuildRuntime = mockDiscord({ actualGuildId: wrongGuildId });
  const second = new VoiceSummaryPublisher({ client: wrongGuildRuntime.client, guildId, outputChannelId: channelId });
  await assert.rejects(
    second.publish({ session: { guildId }, transcript: rawTranscript(), analysis: analysis() }),
    (error) => error.code === "voice_summary_guild_mismatch",
  );
  assert.equal(wrongGuildRuntime.sent.length, 0);
});

test("publisherはprivate・credential付きsource URLを送信前に拒否する", async () => {
  const { client, sent } = mockDiscord();
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });
  for (const url of ["https://127.0.0.1/private", "https://user:pass@example.com/private"]) {
    await assert.rejects(
      publisher.publish({
        session: { guildId },
        transcript: rawTranscript(),
        analysis: analysis({
          factChecks: [{ claim: "claim", verdict: "verified", summary: "summary", sources: [{ title: "bad", url }] }],
        }),
      }),
      (error) => error.code === "unsafe_source_url",
    );
  }
  assert.equal(sent.length, 0);
});

test("publisherは長いsummaryを分割し最後の投稿へ文字起こしtxtを一度だけ添付する", async () => {
  const { client, sent } = mockDiscord();
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });
  const longTopics = Array.from({ length: 12 }, (_, index) => `${index + 1}: ${"長い要約内容".repeat(45)}`);
  await publisher.publish({
    session: { guildId },
    transcript: rawTranscript(),
    analysis: analysis({
      factCheckUsed: false,
      factChecks: [],
      minutes: {
        overview: "長い会議の概要",
        topics: longTopics,
        decisions: [],
        actionItems: [],
        openQuestions: [],
        publicClaims: [],
      },
    }),
  });

  assert.ok(sent.length > 1);
  assert.ok(sent.every((payload) => payload.content.length <= 2_000));
  assert.equal(sent.filter((payload) => Array.isArray(payload.files)).length, 1);
  assert.equal(sent.slice(0, -1).some((payload) => Array.isArray(payload.files)), false);
  assert.equal(sent.at(-1).files[0].name, "voice-transcript.txt");
  assert.ok(sent.every((payload) => payload.allowedMentions.parse.length === 0));
});
