import assert from "node:assert/strict";
import test from "node:test";
import { parseTemplateManagementMessage } from "../src/attendance-templates.mjs";
import { buildMeetingCommand } from "../src/commands.mjs";
import {
  isHelpIntent,
  isTemplateHelpIntent,
  parseGuildNaturalCommand,
} from "../src/local-command-router.mjs";
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
  assert.equal(parseGuildNaturalCommand("7月27日20時 使い方改善会議 https://meet.google.com/example-room"), null);
  assert.equal(parseGuildNaturalCommand("次の会議は7月27日20時 新商品MTG https://meet.google.com/example-room"), null);
});

test("会議URL差し替えは7〜8文字IDや自然な指示をローカル操作として判定する", () => {
  assert.deepEqual(
    parseGuildNaturalCommand("https://calendar.app.google/example-token"),
    { action: "meeting_url_update", meetingId: null, hasMeetingUrl: true },
  );
  assert.deepEqual(
    parseGuildNaturalCommand("https://meet.google.com/example-room"),
    { action: "meeting_url_update", meetingId: null, hasMeetingUrl: true },
  );
  assert.deepEqual(
    parseGuildNaturalCommand("meeting url id:ABC1234 url:https://meet.google.com/example-room"),
    { action: "meeting_url_update", meetingId: "ABC1234", hasMeetingUrl: true },
  );
  assert.deepEqual(
    parseGuildNaturalCommand("MEET0001のURLを https://meet.google.com/example-room に差し替えて"),
    { action: "meeting_url_update", meetingId: "MEET0001", hasMeetingUrl: true },
  );
  assert.deepEqual(
    parseGuildNaturalCommand("このリンクにして https://meet.google.com/example-room"),
    { action: "meeting_url_update", meetingId: null, hasMeetingUrl: true },
  );
  assert.equal(
    parseGuildNaturalCommand("全体MTGのGoogleミートのリンク、これね https://meet.google.com/example-room"),
    null,
  );
  assert.equal(
    parseGuildNaturalCommand("全体MTGを新しく登録。Googleミートのリンク、これね https://meet.google.com/example-room"),
    null,
  );
});

test("実在する全英字会議IDは小文字入力でもローカル管理操作に使える", () => {
  assert.deepEqual(
    parseGuildNaturalCommand("abcdefghを中止して", { knownMeetingIds: ["ABCDEFGH"] }),
    { action: "meeting_cancel", meetingId: "ABCDEFGH" },
  );
});

test("日時・会議名・参加者・URLが混在する入力はURL更新へ横取りせずAI解析へ回す", () => {
  assert.equal(parseGuildNaturalCommand(
    "メンバーA メンバーB 7月21日19時 全体MTG https://meet.google.com/example-room",
  ), null);
  assert.equal(parseGuildNaturalCommand(
    "https://meet.google.com/example-room メンバーC 来週火曜20時 定例会",
  ), null);
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

test("テンプレートの作り方を聞かれたら会議作成ではなく専用ヘルプへ振り分ける", () => {
  for (const text of [
    "テンプレどうやって作る？",
    "参加者テンプレートの作り方を教えて",
    "テンプレートを登録する方法が知りたい",
  ]) {
    assert.equal(isTemplateHelpIntent(text), true, text);
    assert.deepEqual(parseGuildNaturalCommand(text), { action: "template_help" }, text);
  }
  assert.equal(isTemplateHelpIntent("テンプレート「全体定例」を既定にして"), false);
});

test("全Slashサブコマンドに通常チャンネル@メンションの自然言語経路がある", () => {
  const slashNames = buildMeetingCommand().toJSON().options.map((option) => option.name);
  assert.deepEqual(slashNames, [
    "create", "url", "list", "status", "cancel",
    "member-add", "member-list", "member-remove",
    "template-save", "template-list", "template-show", "template-default", "template-remove",
    "invite", "my-reminders",
    "voice-start", "voice-stop", "voice-status", "voice-privacy", "voice-reprocess", "voice-delete",
    "help",
  ]);

  assert.deepEqual(parseGuildNaturalCommand("VCの文字起こしを開始して"), { action: "voice_start", title: null });
  assert.deepEqual(parseGuildNaturalCommand("VCの録音を止めて"), { action: "voice_stop" });
  assert.deepEqual(parseGuildNaturalCommand("VC文字起こしの状態を見せて"), { action: "voice_status" });
  assert.deepEqual(parseGuildNaturalCommand("VC録音のプライバシーを教えて"), { action: "voice_privacy" });
  assert.deepEqual(parseGuildNaturalCommand("A1B2C3D4E5 を再処理して"), { action: "voice_reprocess", sessionId: "A1B2C3D4E5" });
  assert.deepEqual(parseGuildNaturalCommand("A1B2C3D4E5 を削除して"), { action: "voice_delete", sessionId: "A1B2C3D4E5" });

  assert.deepEqual(parseGuildNaturalCommand("使い方"), { action: "help" });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート「全体定例」として参加者: メンバーA、メンバーB を保存"), { action: "save", name: "全体定例" });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート 「全体定例」として参加者: メンバーA、メンバーB を保存"), { action: "save", name: "全体定例" });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート一覧を見せて"), { action: "list", name: null });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート「全体定例」を見せて"), { action: "show", name: "全体定例" });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート「全体定例」を既定にして"), { action: "set_default", name: "全体定例" });
  assert.deepEqual(parseTemplateManagementMessage("テンプレート「全体定例」を削除して"), { action: "remove", name: "全体定例" });
  assert.deepEqual(parsePersonalReminderRequest("今後は1時間前と10分前に通知して"), {
    minutes: [60, 10],
    scope: "default",
    needsClarification: false,
  });

  // create は会議AI解析へ、URL更新はURLとIDをローカル分離する経路へ進む。
  assert.equal(parseGuildNaturalCommand("明日20時に全体定例を作成、URLは省略せず指定"), null);
  assert.deepEqual(parseGuildNaturalCommand("MEET0001 のURLを変更して"), {
    action: "meeting_url_update",
    meetingId: "MEET0001",
    hasMeetingUrl: false,
  });
});
