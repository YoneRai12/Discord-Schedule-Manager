import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

const MODEL_ENV = "OPENAI_MEETING_MODEL";
const REASONING_ENV = "OPENAI_REASONING_EFFORT";
const PROVIDER_ENV = "MEETING_AI_PROVIDER";
const CODEX_MODEL_ENV = "CODEX_MEETING_MODEL";
const CODEX_REASONING_ENV = "CODEX_REASONING_EFFORT";
const ATTENDEE_MENTION_ENV = "MEETING_ATTENDEE_MENTION_OFFSETS_MINUTES";
const LEGACY_EVERYONE_ENV = "MEETING_EVERYONE_OFFSETS_MINUTES";
const VOICE_ENV_NAMES = [
  "MEETING_VOICE_ENABLED",
  "MEETING_VOICE_OUTPUT_CHANNEL_ID",
  "MEETING_VOICE_RETENTION_HOURS",
  "MEETING_VOICE_ARCHIVE_KEY",
  "MEETING_VOICE_ARCHIVE_DIR",
  "MEETING_VOICE_AI_SUMMARY_ENABLED",
  "MEETING_VOICE_FACT_CHECK_ENABLED",
  "MEETING_VOICE_STT_DEVICE",
];

function withOpenAiEnvironment(values, callback) {
  const previous = new Map(
    [
      MODEL_ENV,
      REASONING_ENV,
      PROVIDER_ENV,
      CODEX_MODEL_ENV,
      CODEX_REASONING_ENV,
      ATTENDEE_MENTION_ENV,
      LEGACY_EVERYONE_ENV,
      ...VOICE_ENV_NAMES,
    ]
      .map((name) => [name, process.env[name]]),
  );
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
    return callback();
  } finally {
    for (const [name, value] of previous) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("OpenAI会議解釈はGPT-5.6 Terra・reasoning mediumを既定値にする", () => {
  withOpenAiEnvironment({ [MODEL_ENV]: null, [REASONING_ENV]: null, [PROVIDER_ENV]: null }, () => {
    const config = loadConfig({ requireSecrets: false });
    assert.equal(config.meetingAiProvider, "openai");
    assert.equal(config.openaiModel, "gpt-5.6-terra");
    assert.equal(config.openaiReasoningEffort, "medium");
  });
});

test("VC文字起こしは既定OFFで、保存期間は24時間に固定する", () => {
  withOpenAiEnvironment(Object.fromEntries(VOICE_ENV_NAMES.map((name) => [name, null])), () => {
    const config = loadConfig({ requireSecrets: false });
    assert.equal(config.meetingVoiceEnabled, false);
    assert.equal(config.meetingVoiceRetentionHours, 24);
    assert.equal(config.meetingVoiceAiSummaryEnabled, false);
  });
  withOpenAiEnvironment({ MEETING_VOICE_RETENTION_HOURS: "48" }, () => {
    assert.throws(() => loadConfig({ requireSecrets: false }), /MEETING_VOICE_RETENTION_HOURS/u);
  });
});

test("VC文字起こし有効時は専用チャンネルと32バイト暗号鍵を必須にする", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  withOpenAiEnvironment({
    MEETING_VOICE_ENABLED: "true",
    MEETING_VOICE_OUTPUT_CHANNEL_ID: "1234567890" + "12345678",
    MEETING_VOICE_ARCHIVE_KEY: key,
    MEETING_VOICE_STT_DEVICE: "auto",
  }, () => {
    assert.equal(loadConfig({ requireSecrets: false }).meetingVoiceEnabled, true);
  });
  withOpenAiEnvironment({
    MEETING_VOICE_ENABLED: "true",
    MEETING_VOICE_OUTPUT_CHANNEL_ID: null,
    MEETING_VOICE_ARCHIVE_KEY: key,
  }, () => {
    assert.throws(() => loadConfig({ requireSecrets: false }), /MEETING_VOICE_OUTPUT_CHANNEL_ID/u);
  });
});

test("Codex App ServerはSpark・thinking mediumを設定で選べる", () => {
  withOpenAiEnvironment({
    [PROVIDER_ENV]: "codex_app_server",
    [CODEX_MODEL_ENV]: null,
    [CODEX_REASONING_ENV]: null,
  }, () => {
    const config = loadConfig({ requireSecrets: false });
    assert.equal(config.meetingAiProvider, "codex_app_server");
    assert.equal(config.codexMeetingModel, "gpt-5.3-codex-spark");
    assert.equal(config.codexReasoningEffort, "medium");
  });
});

test("参加者メンション時刻は新設定を優先し旧設定からも安全に移行できる", () => {
  withOpenAiEnvironment({
    [ATTENDEE_MENTION_ENV]: "10,0",
    [LEGACY_EVERYONE_ENV]: "30",
  }, () => {
    assert.deepEqual(loadConfig({ requireSecrets: false }).attendeeMentionOffsets, [10, 0]);
  });
  withOpenAiEnvironment({
    [ATTENDEE_MENTION_ENV]: null,
    [LEGACY_EVERYONE_ENV]: "30,0",
  }, () => {
    assert.deepEqual(loadConfig({ requireSecrets: false }).attendeeMentionOffsets, [30, 0]);
  });
});

test("将来のsnapshotを妨げないようモデル名は透過し、reasoningの許可外値だけを拒否する", () => {
  withOpenAiEnvironment({
    [MODEL_ENV]: "gpt-5.6-terra-future-snapshot",
    [REASONING_ENV]: "medium",
  }, () => {
    assert.equal(
      loadConfig({ requireSecrets: false }).openaiModel,
      "gpt-5.6-terra-future-snapshot",
    );
  });
  withOpenAiEnvironment({ [MODEL_ENV]: "gpt-5.6-terra", [REASONING_ENV]: "extreme" }, () => {
    assert.throws(
      () => loadConfig({ requireSecrets: false }),
      /OPENAI_REASONING_EFFORT/u,
    );
  });
});
