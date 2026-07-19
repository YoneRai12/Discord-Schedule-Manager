import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

const MODEL_ENV = "OPENAI_MEETING_MODEL";
const REASONING_ENV = "OPENAI_REASONING_EFFORT";

function withOpenAiEnvironment(values, callback) {
  const previous = new Map(
    [MODEL_ENV, REASONING_ENV].map((name) => [name, process.env[name]]),
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
  withOpenAiEnvironment({ [MODEL_ENV]: null, [REASONING_ENV]: null }, () => {
    const config = loadConfig({ requireSecrets: false });
    assert.equal(config.openaiModel, "gpt-5.6-terra");
    assert.equal(config.openaiReasoningEffort, "medium");
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
