import assert from "node:assert/strict";
import test from "node:test";
import { MeetingInterpreter, validateInterpretation } from "../src/interpreter.mjs";

function validOutput(overrides = {}) {
  return {
    action: "create",
    meetingId: null,
    title: "運営定例",
    startsAt: "2026-07-20T20:30:00+09:00",
    durationMinutes: 60,
    reminderMinutes: [30, 0],
    providedFields: ["title", "startsAt", "meetingUrl"],
    missingFields: [],
    confidence: 0.97,
    clarification: null,
    ...overrides,
  };
}

test("OpenAIへは伏せ字本文とURL有無だけをstore:falseで送る", async () => {
  const calls = [];
  const client = {
    responses: {
      create: async (request) => {
        calls.push(request);
        return { output_text: JSON.stringify(validOutput()) };
      },
    },
  };
  const interpreter = new MeetingInterpreter({
    client,
    model: "test-model",
    defaultReminderMinutes: [30, 0],
  });
  const result = await interpreter.interpret({
    sanitizedText: "来週月曜20:30から運営定例 [URL_REDACTED]",
    hasMeetingUrl: true,
    nowMs: Date.parse("2026-07-18T00:00:00Z"),
  });

  assert.equal(result.action, "create");
  assert.equal(result.missingFields.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].store, false);
  assert.equal(calls[0].text.format.type, "json_schema");
  const serialized = JSON.stringify(calls[0]);
  assert.equal(serialized.includes("uniqueItems"), false);
  assert.equal(serialized.includes("meet.google.com"), false);
  assert.equal(serialized.includes("discord-user-example"), false);
  assert.match(serialized, /URL_REDACTED/u);
});

test("Structured Outputsで禁止されるuniqueItemsを使わずローカルで重複除去する", () => {
  const result = validateInterpretation(validOutput({
    providedFields: ["title", "title", "startsAt", "meetingUrl", "meetingUrl"],
  }), {
    hasMeetingUrl: true,
    nowMs: Date.parse("2026-07-18T00:00:00Z"),
  });

  assert.deepEqual(result.providedFields, ["title", "startsAt", "meetingUrl"]);
});

test("AIが不足なしと答えてもURL有無はローカルで再判定する", () => {
  const result = validateInterpretation(validOutput(), {
    hasMeetingUrl: false,
    nowMs: Date.parse("2026-07-18T00:00:00Z"),
  });
  assert.deepEqual(result.missingFields, ["meetingUrl"]);
});

test("AI出力にURLが混入した場合は結果全体を破棄する", () => {
  assert.throws(() => validateInterpretation(validOutput({
    clarification: "https://example.com を使ってください",
  }), {
    hasMeetingUrl: true,
    nowMs: Date.parse("2026-07-18T00:00:00Z"),
  }), /AI出力にURL/u);
});
