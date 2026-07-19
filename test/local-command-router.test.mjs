import assert from "node:assert/strict";
import test from "node:test";
import { parseTemplateManagementMessage } from "../src/attendance-templates.mjs";
import { buildMeetingCommand } from "../src/commands.mjs";
import { isHelpIntent, parseGuildNaturalCommand } from "../src/local-command-router.mjs";
import { parsePersonalReminderRequest } from "../src/personal-reminders.mjs";

test("Slash Command相当の通常チャンネル@メンション操作をローカル判定する", () => {
  assert.deepEqual(parseGuildNaturalCommand("会議一覧を見せて"), { action: "meeting_list" });
  assert.deepEqual(parseGuildNaturalCommand("ABCD1234 の出欠状況を見せて"), { action: "meeting_status", meetingId: "ABCD1234" });
  assert.deepEqual(parseGuildNaturalCommand("会議 ABCD1234 を中止して"), { action: "meeting_cancel", meetingId: "ABCD1234" });
  assert.deepEqual(parseGuildNaturalCommand("呼び名一覧を見せて"), { action: "member_list" });
  assert.deepEqual(parseGuildNaturalCommand("この人を「メンバーA」として登録して"), { action: "member_add", alias: "メンバーA" });
  assert.deepEqual(parseGuildNaturalCommand("呼び名「メンバーA」を削除して"), { action: "member_remove", alias: "メンバーA" });
  assert.deepEqual(parseGuildNaturalCommand("ABCD1234 の招待DMを送って"), { action: "meeting_invite", meetingId: "ABCD1234" });
  assert.deepEqual(parseGuildNaturalCommand("自分の個人通知設定を見せて"), { action: "my_reminders_show" });
  assert.deepEqual(parseGuildNaturalCommand("MEET0001の出欠状況"), { action: "meeting_status", meetingId: "MEET0001" });
  assert.deepEqual(
    parseGuildNaturalCommand(`<@${"1".repeat(18)}>をメンバーBとして登録して`),
    { action: "member_add", alias: "メンバーB" },
  );
});

test("会議作成・更新の自由文はAI会議解析へフォールスルーする", () => {
  assert.equal(parseGuildNaturalCommand("明日20時から定例会を登録して"), null);
});

test("くだけた聞き方でも使い方ヘルプとしてAIへ送らず判定する", () => {
  for (const text of [
    "どうやって使うの",
    "どーやってつかうの？",
    "このBotどう使えばいい？",
    "使い方教えて",
    "初めてだから使いかたを説明して",
    "何できるの？",
    "何が出来るのか教えて",
    "機能を見せて",
    "help",
  ]) {
    assert.equal(isHelpIntent(text), true, text);
    assert.deepEqual(parseGuildNaturalCommand(text), { action: "help" }, text);
  }
  assert.equal(isHelpIntent("明日20時から定例会を登録して"), false);
  assert.equal(parseGuildNaturalCommand("明日20時から定例会を登録して"), null);
});

test("全Slashサブコマンドに通常チャンネル@メンションの自然言語経路がある", () => {
  const slashNames = buildMeetingCommand().toJSON().options.map((option) => option.name);
  assert.deepEqual(slashNames, [
    "create", "url", "list", "status", "cancel",
    "member-add", "member-list", "member-remove",
    "template-save", "template-list", "template-show", "template-default", "template-remove",
    "invite", "my-reminders", "help",
  ]);

  assert.deepEqual(parseGuildNaturalCommand("使い方"), { action: "help" });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート「全体定例」として参加者: メンバーA、メンバーB を保存"), { action: "save", name: "全体定例" });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート一覧を見せて"), { action: "list", name: null });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート「全体定例」を見せて"), { action: "show", name: "全体定例" });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート「全体定例」を既定にして"), { action: "set_default", name: "全体定例" });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート「全体定例」を削除して"), { action: "remove", name: "全体定例" });
  assert.deepEqual(parsePersonalReminderRequest("今後は1時間前と10分前に通知して"), {
    minutes: [60, 10],
    scope: "default",
    needsClarification: false,
  });

  // create と url は、URL等をローカル分離してから会議AI解析へフォールスルーする。
  assert.equal(parseGuildNaturalCommand("明日20時に全体定例を作成、URLは省略せず指定"), null);
  assert.equal(parseGuildNaturalCommand("MEET0001 のURLを変更して"), null);
});
