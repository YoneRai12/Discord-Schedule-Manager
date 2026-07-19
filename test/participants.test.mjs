import assert from "node:assert/strict";
import test from "node:test";
import {
  extractParticipantDirective,
  normalizeMemberAlias,
  parseMemberAliasList,
  redactKnownMemberAliases,
} from "../src/participants.mjs";

test("参加者の呼び名をAIへ渡す本文からローカルで分離する", () => {
  const extracted = extractParticipantDirective("明日20時から定例会。参加者: メンバーA、メンバーB。URLは https://example.com");
  assert.deepEqual(extracted.aliases, ["メンバーA", "メンバーB"]);
  assert.equal(extracted.cleanedText.includes("メンバーA"), false);
  assert.equal(extracted.cleanedText.includes("メンバーB"), false);
  assert.match(extracted.cleanedText, /\[MEMBERS_REDACTED\]/u);
});

test("登録済みの呼び名は参加者行以外にあってもAI送信前に伏せる", () => {
  const text = redactKnownMemberAliases("メンバーAへ確認して、メンバーBも対象", ["メンバーA", "メンバーB"]);
  assert.equal(text.includes("メンバーA"), false);
  assert.equal(text.includes("メンバーB"), false);
  assert.equal((text.match(/\[MEMBER_ALIAS\]/gu) || []).length, 2);
});

test("呼び名は安全な文字だけを許可して重複を除く", () => {
  assert.deepEqual(parseMemberAliasList("メンバーA, メンバーB、メンバーA"), ["メンバーA", "メンバーB"]);
  assert.equal(normalizeMemberAlias("ＭＥＭＢＥＲ＿Ａ").alias, "MEMBER_A");
  assert.throws(() => normalizeMemberAlias("@everyone"), /使える/u);
  assert.throws(() => normalizeMemberAlias("あ"), /2〜32/u);
  assert.throws(() => normalizeMemberAlias("https://example.com"), /使える/u);
});
