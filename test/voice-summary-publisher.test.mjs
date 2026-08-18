import assert from "node:assert/strict";
import test from "node:test";
import { VoiceSummaryPublisher } from "../src/voice/voice-summary-publisher.mjs";

const fakeId = (prefix) => `${prefix}${"234567890"}${"12345678"}`;
const guildId = fakeId(1);
const channelId = fakeId(2);
const wrongGuildId = fakeId(9);

function mockDiscord({ actualGuildId = guildId, editError = null } = {}) {
  const sent = [];
  const edited = [];
  const messages = new Map();
  const existingId = fakeId(3);
  const existingMessage = {
    id: existingId,
    async edit(nextPayload) {
      if (editError) throw editError;
      edited.push(nextPayload);
      return existingMessage;
    },
  };
  messages.set(existingId, existingMessage);
  const channel = {
    id: channelId,
    guildId: actualGuildId,
    isTextBased: () => true,
    async send(payload) {
      sent.push(payload);
      const id = String(BigInt(fakeId(3)) + BigInt(sent.length));
      const message = {
        id,
        async edit(nextPayload) {
          if (editError) throw editError;
          edited.push(nextPayload);
          return message;
        },
      };
      messages.set(id, message);
      return message;
    },
    messages: { async fetch(id) { return messages.get(String(id)) || null; } },
  };
  const guild = {
    id: actualGuildId,
    channels: { async fetch(id) { return id === channelId ? channel : null; } },
  };
  const client = { guilds: { async fetch() { return guild; } } };
  return { client, sent, edited, messages, existingId };
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
  const { client, sent, edited, existingId } = mockDiscord();
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });
  const audio = Buffer.from("not-audio-for-discord");
  const result = await publisher.publish({
    session: { guildId, outputChannelId: channelId, resultMessageId: existingId, audio, audioPath: "C:\\private\\meeting.wav" },
    transcript: rawTranscript(),
    analysis: analysis(),
  });

  assert.equal(result.channelId, channelId);
  assert.match(result.messageId, /^\d{16,20}$/u);
  assert.equal(result.publicationRevision, 1);
  assert.ok(Number.isSafeInteger(result.publicationCompletedAtMs));
  assert.equal(sent.length, 0);
  assert.equal(edited.length, 1);
  assert.deepEqual(edited[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.doesNotMatch(edited[0].content, /@everyone|@here|<@/u);
  assert.match(edited[0].content, /<https:\/\/example\.com\/report>/u);
  assert.equal(edited[0].files.length, 1);
  assert.equal(edited[0].files[0].name, "voice-transcript.txt");
  assert.ok(Buffer.isBuffer(edited[0].files[0].attachment));
  assert.notEqual(edited[0].files[0].attachment, audio);
  const attachedText = edited[0].files[0].attachment.toString("utf8");
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

test("publisherは長いsummaryを完全版txtにし、文字起こしと同じ単一メッセージに添付する", async () => {
  const { client, sent, edited, existingId } = mockDiscord();
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });
  const longTopics = Array.from({ length: 12 }, (_, index) => `${index + 1}: ${"長い要約内容".repeat(45)}`);
  await publisher.publish({
    session: { guildId, resultMessageId: existingId },
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

  assert.equal(sent.length, 0);
  assert.equal(edited.length, 1);
  assert.ok(edited[0].content.length <= 2_000);
  assert.match(edited[0].content, /voice-minutes\.txt/u);
  assert.deepEqual(edited[0].files.map((file) => file.name), ["voice-minutes.txt", "voice-transcript.txt"]);
  assert.match(edited[0].files[0].attachment.toString("utf8"), /長い要約内容/u);
  assert.equal(edited[0].allowedMentions.parse.length, 0);
});

test("publisherは公開済みメッセージを再実行時にeditし、send件数を増やさない", async () => {
  const { client, sent, edited, existingId } = mockDiscord();
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });
  const first = await publisher.publish({
    session: { guildId, outputChannelId: channelId, resultMessageId: existingId },
    transcript: rawTranscript(),
    analysis: analysis(),
  });
  const second = await publisher.publish({
    session: {
      guildId,
      outputChannelId: channelId,
      resultMessageId: first.messageId,
      publicationRevision: first.publicationRevision,
    },
    transcript: rawTranscript(),
    analysis: analysis({
      minutes: {
        overview: "更新後の概要",
        topics: [],
        decisions: [],
        actionItems: [],
        openQuestions: [],
        publicClaims: [],
      },
    }),
  });

  assert.equal(sent.length, 0);
  assert.equal(edited.length, 2);
  assert.equal(second.messageId, first.messageId);
  assert.equal(second.publicationRevision, 2);
  assert.equal(edited[1].attachments.length, 0);
  assert.deepEqual(edited[1].files.map((file) => file.name), ["voice-transcript.txt"]);
  assert.match(edited[1].content, /更新後の概要/u);
  assert.deepEqual(edited[1].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
});

test("publisherは開始前のabortでDiscordを更新しない", async () => {
  const abortController = new AbortController();
  abortController.abort("deleted");
  const { client, sent, edited } = mockDiscord();
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });

  await assert.rejects(publisher.publish({
    session: { guildId },
    transcript: rawTranscript(),
    analysis: analysis(),
    signal: abortController.signal,
  }), (error) => error?.code === "ABORTED");
  assert.equal(sent.length, 0);
  assert.equal(edited.length, 0);
});

test("publisherはcheckpoint済みresultMessageIdなしの新規sendを拒否する", async () => {
  const { client, sent, edited } = mockDiscord();
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });
  await assert.rejects(publisher.publish({
    session: { guildId },
    transcript: rawTranscript(),
    analysis: analysis(),
  }), (error) => error?.code === "PUBLISH_MESSAGE_ID_REQUIRED");
  assert.equal(sent.length, 0);
  assert.equal(edited.length, 0);
});

test("publisherは既存edit中のabortをedit完了後にABORTEDとして返す", async () => {
  const abortController = new AbortController();
  let edits = 0;
  const existingId = fakeId(3);
  const existing = {
    id: existingId,
    async edit() {
      edits += 1;
      abortController.abort("deleted");
      return existing;
    },
  };
  const channel = {
    id: channelId,
    guildId,
    isTextBased: () => true,
    async send() { throw new Error("unexpected send"); },
    messages: { async fetch() { return existing; } },
  };
  const client = { guilds: { async fetch() {
    return { id: guildId, channels: { async fetch() { return channel; } } };
  } } };
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });

  await assert.rejects(publisher.publish({
    session: { guildId, resultMessageId: existingId, publicationRevision: 1 },
    transcript: rawTranscript(),
    analysis: analysis(),
    signal: abortController.signal,
  }), (error) => error?.code === "ABORTED");
  assert.equal(edits, 1);
});

test("publisherは既存メッセージのfetch・edit失敗を固定codeだけで表面化する", async () => {
  const sent = [];
  const channel = {
    id: channelId,
    guildId,
    isTextBased: () => true,
    async send(payload) {
      sent.push(payload);
      return { id: fakeId(3) };
    },
    messages: { async fetch() { throw new Error("private discord detail"); } },
  };
  const client = { guilds: { async fetch() {
    return { id: guildId, channels: { async fetch() { return channel; } } };
  } } };
  const publisher = new VoiceSummaryPublisher({ client, guildId, outputChannelId: channelId });
  await assert.rejects(publisher.publish({
    session: { guildId, resultMessageId: fakeId(3), publicationRevision: 4 },
    transcript: rawTranscript(),
    analysis: analysis(),
  }), (error) => error?.code === "PUBLISH_EDIT_FAILED" && !error.message.includes("private discord detail"));
  assert.equal(sent.length, 0);
});
