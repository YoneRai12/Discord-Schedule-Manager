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

test("会議IDがAI送信直前まで残った場合は安全側で停止する", () => {
  assert.throws(
    () => assertSafeForAi("この会議（ABCD2345）を更新"),
    /会議ID/u,
  );
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

test("スキームなしの招待URLと任意ドメインURLもAIへ送らない", () => {
  const result = extractAndRedactSensitiveText(
    "招待 calendar.app.google/abc123 または example.com/secret-room",
  );
  assert.deepEqual(result.urls, [
    "https://calendar.app.google/abc123",
    "https://example.com/secret-room",
  ]);
  assert.equal(result.sanitizedText.includes("calendar.app.google"), false);
  assert.equal(result.sanitizedText.includes("example.com"), false);
  assert.doesNotThrow(() => assertSafeForAi(result.sanitizedText));
});

test("スラッシュなしURLのquery・fragment・bare domainもAIへ送らない", () => {
  const result = extractAndRedactSensitiveText(
    "候補は zoom.us?pwd=private-value と example.com#private-fragment と bare.example です",
  );
  assert.equal(result.urls.length, 3);
  assert.equal(result.sanitizedText.includes("private-value"), false);
  assert.equal(result.sanitizedText.includes("private-fragment"), false);
  assert.equal(result.sanitizedText.includes("bare.example"), false);
  assert.doesNotThrow(() => assertSafeForAi(result.sanitizedText));
});

test("スキームなしIPv4・日本語ドメイン・punycodeもAIへ送らない", () => {
  const result = extractAndRedactSensitiveText(
    "接続先 192.168.1.1/secret-room、例え.テスト/秘密、xn--r8jz45g.xn--zckzah/path",
  );
  assert.equal(result.urls.length, 3);
  assert.equal(result.sanitizedText.includes("192.168.1.1"), false);
  assert.equal(result.sanitizedText.includes("例え.テスト"), false);
  assert.equal(result.sanitizedText.includes("xn--"), false);
  assert.doesNotThrow(() => assertSafeForAi(result.sanitizedText));
});

test("Windows風backslashを含むスキームなしURLもpathごとAIへ送らない", () => {
  const result = extractAndRedactSensitiveText(
    "接続先 example.com\\private-secret、192.168.1.1\\internal-room、例え.テスト\\秘密",
  );
  assert.equal(result.urls.length, 3);
  assert.equal(result.sanitizedText.includes("private-secret"), false);
  assert.equal(result.sanitizedText.includes("internal-room"), false);
  assert.equal(result.sanitizedText.includes("秘密"), false);
  assert.doesNotThrow(() => assertSafeForAi(result.sanitizedText));
});

test("WHATWG特殊IPv4・末尾dot・不正ラベル・絵文字ドメインのpathをAIへ送らない", () => {
  const candidates = [
    "127.1/private-secret",
    "127.0.1/private-secret",
    "2130706433/private-secret",
    "0x7f000001/private-secret",
    "0177.0.0.1/private-secret",
    "example.com./private-secret",
    "foo_bar.example/private-secret",
    "-foo.example/private-secret",
    "foo-.example/private-secret",
    "💩.la/private-secret",
    "example.com:1/private-secret",
    "example.com:9\\private-secret",
    "example.com:999999/private-secret",
    "example.com:_foo/private-secret",
    "example.com-evil/private-secret",
    "example.com%2Fprivate-secret",
    "example.com💩/private-secret",
    "example.com∕private-secret",
    "example。com/private-secret",
    "example.com9/private-secret",
    "example.com0x/private-secret",
    "example.com(foo)/private-secret",
    "example.com(foo/private-secret",
    "example.com)foo/private-secret",
    "example.com[foo/private-secret",
    "example.com]foo/private-secret",
    "example.com{foo/private-secret",
    "example.com}foo/private-secret",
    "example.com!foo/private-secret",
    "example.com&foo/private-secret",
    "example.com,foo/private-secret",
    "example.com;foo/private-secret",
    "example.com*foo/private-secret",
    "example.com123private-secret",
    "[::1]/private-secret",
    "[2001:db8::1]/private-secret",
  ];
  for (const candidate of candidates) {
    const result = extractAndRedactSensitiveText(`接続先 ${candidate} です`);
    assert.equal(result.sanitizedText.includes("private-secret"), false, candidate);
    assert.doesNotThrow(() => assertSafeForAi(result.sanitizedText), candidate);
  }
});

test("国際化メールアドレスもAI送信前に伏せる", () => {
  for (const email of ["user@例え.テスト", "ユーザー@example.com", "ユーザー@例え.テスト"]) {
    const result = extractAndRedactSensitiveText(`連絡先は ${email} です`);
    assert.equal(result.sanitizedText.includes(email), false, email);
    assert.match(result.sanitizedText, /\[EMAIL_REDACTED\]/u, email);
    assert.doesNotThrow(() => assertSafeForAi(result.sanitizedText), email);
  }
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
  assert.equal(normalizeMeetingUrl("192.168.1.1/room"), "https://192.168.1.1/room");
  assert.throws(() => normalizeMeetingUrl("http://meet.example.com/room"), /https/u);
  assert.throws(() => normalizeMeetingUrl("https://user:pass@example.com/room"), /認証情報/u);
  assert.throws(() => normalizeMeetingUrl("127.1/private-secret"), /ホスト名/u);
  assert.throws(() => normalizeMeetingUrl("foo_bar.example/private-secret"), /ホスト名/u);
});

test("表示テキストから意図しないメンションを無効化する", () => {
  assert.equal(safeDisplayText(`@everyone 定例 <@${DISCORD_ID}>`), "＠everyone 定例 [メンション]");
});
