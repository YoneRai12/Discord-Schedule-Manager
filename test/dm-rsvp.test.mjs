import assert from "node:assert/strict";
import test from "node:test";
import { parseDirectMessageRsvp } from "../src/dm-rsvp.mjs";

test("DMの自然な日本語をGPTなしで出欠へ分類する", () => {
  assert.deepEqual(parseDirectMessageRsvp("参加します！"), { meetingId: null, status: "attending" });
  assert.deepEqual(parseDirectMessageRsvp("まだ分からないので未定です"), { meetingId: null, status: "maybe" });
  assert.deepEqual(parseDirectMessageRsvp("すみません、参加できません"), { meetingId: null, status: "declined" });
  assert.deepEqual(parseDirectMessageRsvp("ABCD1234 欠席します"), { meetingId: "ABCD1234", status: "declined" });
  assert.equal(parseDirectMessageRsvp("こんにちは"), null);
});
