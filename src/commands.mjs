import { SlashCommandBuilder } from "discord.js";

function addInviteeOptions(command) {
  command.addStringOption((option) => option
    .setName("members")
    .setDescription("登録済みの呼び名（例: メンバーA,メンバーB）")
    .setMaxLength(500));
  command.addStringOption((option) => option
    .setName("template")
    .setDescription("登録済みの参加者テンプレート名")
    .setMaxLength(40));
  for (let index = 1; index <= 5; index += 1) {
    command.addUserOption((option) => option
      .setName(`user${index}`)
      .setDescription(`DMを送るメンバー${index}`));
  }
  return command;
}

export function buildMeetingCommand() {
  return new SlashCommandBuilder()
    .setName("meeting")
    .setDescription("会議の登録・確認・更新を行います")
    .addSubcommand((command) => command
      .setName("create")
      .setDescription("AIを使わず、指定項目から会議を登録します")
      .addStringOption((option) => option
        .setName("title")
        .setDescription("会議名")
        .setRequired(true)
        .setMaxLength(100))
      .addStringOption((option) => option
        .setName("start")
        .setDescription("開始日時（例: 2026-07-20 20:30）")
        .setRequired(true)
        .setMaxLength(40))
      .addStringOption((option) => option
        .setName("url")
        .setDescription("Google Meet・Zoomなどの会議URL")
        .setRequired(true)
        .setMaxLength(2_048))
      .addIntegerOption((option) => option
        .setName("duration")
        .setDescription("予定時間（分）。未指定は60分")
        .setMinValue(5)
        .setMaxValue(1_440))
      .addStringOption((option) => option
        .setName("reminders")
        .setDescription("通知する分前をカンマ区切りで指定（例: 30,10,0）")
        .setMaxLength(80))
      .addStringOption((option) => option
        .setName("members")
        .setDescription("DMを送る登録済みの呼び名（例: メンバーA,メンバーB）")
        .setMaxLength(500))
      .addStringOption((option) => option
        .setName("template")
        .setDescription("参加者テンプレート名。省略時は既定テンプレート")
        .setMaxLength(40))
      .addBooleanOption((option) => option
        .setName("no_dm")
        .setDescription("今回だけ既定テンプレートと個別DMを使わない"))
      .addUserOption((option) => option.setName("user1").setDescription("DMを送るメンバー1"))
      .addUserOption((option) => option.setName("user2").setDescription("DMを送るメンバー2"))
      .addUserOption((option) => option.setName("user3").setDescription("DMを送るメンバー3"))
      .addUserOption((option) => option.setName("user4").setDescription("DMを送るメンバー4"))
      .addUserOption((option) => option.setName("user5").setDescription("DMを送るメンバー5")))
    .addSubcommand((command) => command
      .setName("url")
      .setDescription("既存会議のURLを更新します")
      .addStringOption((option) => option
        .setName("id")
        .setDescription("7〜8文字の会議ID")
        .setRequired(true)
        .setMinLength(7)
        .setMaxLength(8))
      .addStringOption((option) => option
        .setName("url")
        .setDescription("新しい会議URL")
        .setRequired(true)
        .setMaxLength(2_048)))
    .addSubcommand((command) => command
      .setName("list")
      .setDescription("開催予定の会議を一覧表示します"))
    .addSubcommand((command) => command
      .setName("status")
      .setDescription("会議の出欠状況を表示します")
      .addStringOption((option) => option
        .setName("id")
        .setDescription("7〜8文字の会議ID")
        .setRequired(true)
        .setMinLength(7)
        .setMaxLength(8)))
    .addSubcommand((command) => command
      .setName("cancel")
      .setDescription("会議を中止します")
      .addStringOption((option) => option
        .setName("id")
        .setDescription("7〜8文字の会議ID")
        .setRequired(true)
        .setMinLength(7)
        .setMaxLength(8)))
    .addSubcommand((command) => command
      .setName("member-add")
      .setDescription("呼び名とDiscordメンバーを安全に結び付けます")
      .addUserOption((option) => option
        .setName("user")
        .setDescription("呼び名を登録するメンバー")
        .setRequired(true))
      .addStringOption((option) => option
        .setName("alias")
        .setDescription("呼び名（例: メンバーA）")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(32)))
    .addSubcommand((command) => command
      .setName("member-list")
      .setDescription("登録済みの呼び名を管理者だけに表示します"))
    .addSubcommand((command) => command
      .setName("member-remove")
      .setDescription("登録済みの呼び名を削除します")
      .addStringOption((option) => option
        .setName("alias")
        .setDescription("削除する呼び名")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(32)))
    .addSubcommand((command) => addInviteeOptions(command
      .setName("template-save")
      .setDescription("名前付き参加者テンプレートを保存します")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("テンプレート名（例: 運営定例）")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(40))
      .addBooleanOption((option) => option
        .setName("default")
        .setDescription("保存後、このテンプレートを既定にする"))))
    .addSubcommand((command) => command
      .setName("template-list")
      .setDescription("登録済み参加者テンプレートを表示します"))
    .addSubcommand((command) => command
      .setName("template-show")
      .setDescription("参加者テンプレートの内容を表示します")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("テンプレート名")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(40)))
    .addSubcommand((command) => command
      .setName("template-default")
      .setDescription("毎回自動で使う既定テンプレートを選びます")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("テンプレート名")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(40)))
    .addSubcommand((command) => command
      .setName("template-remove")
      .setDescription("参加者テンプレートを削除します")
      .addStringOption((option) => option
        .setName("name")
        .setDescription("テンプレート名")
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(40)))
    .addSubcommand((command) => addInviteeOptions(command
      .setName("invite")
      .setDescription("既存会議の出席確認を個別DMで送ります")
      .addStringOption((option) => option
        .setName("id")
        .setDescription("7〜8文字の会議ID")
        .setRequired(true)
        .setMinLength(7)
        .setMaxLength(8))))
    .addSubcommand((command) => command
      .setName("my-reminders")
      .setDescription("自分の個別DM通知時刻を表示・変更します")
      .addStringOption((option) => option
        .setName("when")
        .setDescription("例: 1時間前と10分前 / 通知なし")
        .setMaxLength(100)))
    .addSubcommand((command) => command
      .setName("voice-start")
      .setDescription("今いるVCで、全員同意後にローカル文字起こしを開始します")
      .addStringOption((option) => option
        .setName("title")
        .setDescription("会議名（省略時は日時から自動作成）")
        .setMaxLength(100)))
    .addSubcommand((command) => command
      .setName("voice-stop")
      .setDescription("VC文字起こしを停止して議事録を作成します"))
    .addSubcommand((command) => command
      .setName("voice-status")
      .setDescription("VC文字起こしの同意・録音状態を確認します"))
    .addSubcommand((command) => command
      .setName("voice-privacy")
      .setDescription("VC文字起こしの保存期間とAI送信範囲を確認します"))
    .addSubcommand((command) => command
      .setName("voice-reprocess")
      .setDescription("24時間以内のバックアップから議事録を再作成します")
      .addStringOption((option) => option
        .setName("session_id")
        .setDescription("10文字のVCセッションID")
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(10)))
    .addSubcommand((command) => command
      .setName("voice-delete")
      .setDescription("24時間を待たずにローカルバックアップを削除します")
      .addStringOption((option) => option
        .setName("session_id")
        .setDescription("10文字のVCセッションID")
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(10)))
    .addSubcommand((command) => command
      .setName("help")
      .setDescription("会議Botの使い方を表示します"));
}
