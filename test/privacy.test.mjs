import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeForAi,
  containsUrlLike,
  extractAndRedactSensitiveText,
  normalizeMeetingUrl,
  safeDisplayText,
} from "../src/privacy.mjs";

const DISCORD_ID = "1".repeat(18);

test("URLとDiscord識別子をAI送信前にローカルで除去する", () => {
  const raw = `<@${DISCORD_ID}> 来週月曜20:30、会議は https://meet.example.com/room。連絡はowner@example.com`;
  const result = extractAndRedactSensitiveText(raw);

  assert.deepEqual(result.urls, ["https://meet.example.com/room"]);
  assert.match(result.sanitizedText, /\[URL_REDACTED\]/u);
  assert.match(result.sanitizedText, /\[DISCORD_MENTION\]/u);
  assert.match(result.sanitizedText, /\[EMAIL_REDACTED\]/u);
  assert.equal(containsUrlLike(result.sanitizedText), false);
  assert.doesNotThrow(() => assertSafeForAi(result.sanitizedText));
});

test("複数URLはローカル配列へ退避し本文には残さない", () => {
  const result = extractAndRedactSensitiveText(
    "候補 https://video.example.com/room-a と https://conference.example.com/room-b",
  );
  assert.equal(result.urls.length, 2);
  assert.equal(containsUrlLike(result.sanitizedText), false);
  assert.equal(result.sanitizedText.includes("video.example.com"), false);
  assert.equal(result.sanitizedText.includes("conference.example.com"), false);
});

test("全角化されたURL・Discord識別子・メールも正規化後にAI本文から除去する", () => {
  const fullwidthDiscordId = [...DISCORD_ID]
    .map((digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0))
    .join("");
  const result = extractAndRedactSensitiveText(
    `ｈｔｔｐｓ：／／ｍｅｅｔ．ｇｏｏｇｌｅ．ｃｏｍ／ａｂｃ－ｄｅｆ ＜＠${fullwidthDiscordId}＞ ｔｅｓｔ＠ｅｘａｍｐｌｅ．ｃｏｍ`,
  );
  assert.equal(result.urls.length, 1);
  assert.equal(result.sanitizedText.includes("meet.google.com"), false);
  assert.equal(result.sanitizedText.includes(DISCORD_ID), false);
  assert.equal(result.sanitizedText.includes("test@example.com"), false);
  assert.doesNotThrow(() => assertSafeForAi(result.sanitizedText));
});

test("https以外や認証情報入りURLを拒否する", () => {
  assert.throws(() => normalizeMeetingUrl("http://meet.example.com/room"), /https/u);
  assert.throws(() => normalizeMeetingUrl("https://user:pass@example.com/room"), /認証情報/u);
});

test("表示テキストから意図しないメンションを無効化する", () => {
  assert.equal(safeDisplayText(`@everyone 定例 <@${DISCORD_ID}>`), "＠everyone 定例 [メンション]");
});
