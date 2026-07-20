import assert from "node:assert/strict";
import test from "node:test";
import { resolveParticipantSnapshot } from "../src/participant-resolution.mjs";
import {
  extractKnownMemberAliases,
  extractParticipantDirective,
  normalizeMemberAlias,
  parseMemberAliasList,
  redactKnownMemberAliases,
} from "../src/participants.mjs";

test("順不同で混ぜた登録済みの呼び名をローカル参加者として抽出する", () => {
  const aliases = ["メンバーA", "メンバーB", "メンバーC", "メンバーD"];
  assert.deepEqual(
    extractKnownMemberAliases("来週火曜20時 メンバーC、メンバーAとメンバーBで全体MTG", aliases),
    ["メンバーC", "メンバーA", "メンバーB"],
  );
  assert.deepEqual(
    extractKnownMemberAliases("全体MTG https://meet.google.com/example メンバーD", aliases),
    ["メンバーD"],
  );
});

test("助詞・敬称・丁寧語を境界として扱い、前方一致する別人を誤抽出しない", () => {
  const aliases = ["担当A", "担当AB", "担当B", "担当C"];
  assert.deepEqual(
    extractKnownMemberAliases("全体MTGは担当ABさんと担当Bで7月21日19時", aliases),
    ["担当AB", "担当B"],
  );
  assert.deepEqual(
    extractKnownMemberAliases("7月21日19時に担当Aと担当Cです", aliases),
    ["担当A", "担当C"],
  );
  assert.deepEqual(extractKnownMemberAliases("担当ABで全体MTG", aliases), ["担当AB"]);
});

test("明示した参加者欄が前後・中間のどこにあっても会議項目を呼び名へ混ぜない", () => {
  const inputs = [
    "参加者: 担当A、担当Bです。会議名: 全体MTG 7月21日19時 URL: https://meet.google.com/example-room",
    "全体MTG 参加者: 担当A、担当Bで 7月21日19時 URL: https://meet.google.com/example-room",
    "全体MTG 7月21日19時 URL: https://meet.google.com/example-room 参加者: 担当A、担当Bです",
  ];
  for (const input of inputs) {
    const extracted = extractParticipantDirective(input);
    assert.deepEqual(extracted.aliases, ["担当A", "担当B"], input);
    assert.equal(extracted.cleanedText.includes("担当A"), false, input);
    assert.equal(extracted.cleanedText.includes("担当B"), false, input);
    assert.match(extracted.cleanedText, /全体MTG/u, input);
    assert.match(extracted.cleanedText, /7月21日19時/u, input);
    assert.match(extracted.cleanedText, /https:\/\/meet\.google\.com\/example-room/u, input);
  }
});

test("同じDiscordユーザーの複数呼び名が現れても会議用参加者は1人にする", () => {
  const aliases = extractKnownMemberAliases("担当Aと別名Aで全体MTG", ["担当A", "別名A"]);
  assert.deepEqual(aliases, ["担当A", "別名A"]);
  const snapshot = resolveParticipantSnapshot({
    explicitParticipantsFound: true,
    explicitInvitees: aliases.map((alias) => ({
      userId: "user-example",
      displayName: alias,
    })),
  });
  assert.deepEqual(snapshot.invitees, [{ userId: "user-example", displayName: "担当A" }]);
});

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

test("全角化した登録済み呼び名もNFKC正規化してAI本文へ残さない", () => {
  const text = redactKnownMemberAliases(
    "担当ＡとMEMBER_Bへ確認",
    ["担当A", "ＭＥＭＢＥＲ＿Ｂ"],
  );
  assert.equal(text.includes("担当Ａ"), false);
  assert.equal(text.includes("担当A"), false);
  assert.equal(text.includes("ＭＥＭＢＥＲ＿Ｂ"), false);
  assert.equal(text.includes("MEMBER_B"), false);
  assert.equal((text.match(/\[MEMBER_ALIAS\]/gu) || []).length, 2);
});

test("呼び名は安全な文字だけを許可して重複を除く", () => {
  assert.deepEqual(parseMemberAliasList("メンバーA, メンバーB、メンバーA"), ["メンバーA", "メンバーB"]);
  assert.equal(normalizeMemberAlias("ＭＥＭＢＥＲ＿Ａ").alias, "MEMBER_A");
  assert.throws(() => normalizeMemberAlias("@everyone"), /使える/u);
  assert.throws(() => normalizeMemberAlias("あ"), /2〜32/u);
  assert.throws(() => normalizeMemberAlias("https://example.com"), /使える/u);
});
