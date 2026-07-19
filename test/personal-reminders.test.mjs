import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPersonalReminderMinutes,
  parsePersonalReminderRequest,
} from "../src/personal-reminders.mjs";

test("個人通知を1時間前と10分前の複数時刻として解析する", () => {
  assert.deepEqual(parsePersonalReminderRequest("今後は毎回、1時間前と10分前に通知して"), {
    minutes: [60, 10],
    scope: "default",
    needsClarification: false,
  });
  assert.deepEqual(parsePersonalReminderRequest("今回は1時間30分前と5分前に知らせて"), {
    minutes: [90, 5],
    scope: "current",
    needsClarification: false,
  });
  assert.deepEqual(parsePersonalReminderRequest("1日前と2時間前"), {
    minutes: [1_440, 120],
    scope: "default_and_current",
    needsClarification: false,
  });
});

test("個人通知なしと説明不足を区別する", () => {
  assert.deepEqual(parsePersonalReminderRequest("通知はいらない"), {
    minutes: [],
    scope: "default_and_current",
    needsClarification: false,
  });
  assert.equal(parsePersonalReminderRequest("こんにちは"), null);
  assert.equal(parsePersonalReminderRequest("通知を変更したい").needsClarification, true);
  assert.equal(formatPersonalReminderMinutes([60, 10]), "1時間前、10分前");
  assert.equal(formatPersonalReminderMinutes([]), "個別通知なし");
});
