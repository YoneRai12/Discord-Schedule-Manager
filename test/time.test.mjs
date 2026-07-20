import assert from "node:assert/strict";
import test from "node:test";
import {
  discordTimestamp,
  normalizeReminderMinutes,
  parseJstDateTime,
  reminderLabel,
} from "../src/time.mjs";

test("Asia/Tokyoのローカル日時をUTC epochへ変換する", () => {
  const value = parseJstDateTime("2026-07-20 20:30");
  assert.equal(new Date(value).toISOString(), "2026-07-20T11:30:00.000Z");
  assert.equal(discordTimestamp(value, "F"), "<t:1784547000:F>");
});
test("存在しない日時を拒否する", () => {
  assert.throws(() => parseJstDateTime("2026-02-30 20:30"), /存在しない/u);
});

test("通知分を重複除去して降順へ揃える", () => {
  assert.deepEqual(normalizeReminderMinutes([0, 30, 10, 30, -1, 99999]), [30, 10, 0]);
  assert.deepEqual(normalizeReminderMinutes([], [30, 0]), []);
  assert.deepEqual(normalizeReminderMinutes(undefined, [30, 0]), [30, 0]);
  assert.equal(reminderLabel(0), "開始時");
  assert.equal(reminderLabel(120), "2時間前");
});
