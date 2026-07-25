import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { buildAttendeeMention } from "./attendee-mentions.mjs";
import { discordTimestamp, reminderLabel } from "./time.mjs";
import { formatPersonalReminderMinutes } from "./personal-reminders.mjs";
import { safeDisplayText } from "./privacy.mjs";

const STATUS_LABELS = {
  attending: "✅ 参加",
  maybe: "🤔 未定",
  declined: "❌ 欠席",
};

function formatNames(rsvps, status) {
  const names = rsvps
    .filter((rsvp) => rsvp.status === status)
    .map((rsvp) => safeDisplayText(rsvp.displayName, 40));
  if (!names.length) return "まだいません";
  const joined = names.join("、");
  return joined.length > 900 ? `${joined.slice(0, 897)}…` : joined;
}

function reminderText(meeting, attendeeMentionOffsets = [0]) {
  const attendeeMentions = new Set(attendeeMentionOffsets.map(Number));
  return meeting.reminderMinutes
    .map((minutes) => `${reminderLabel(minutes)}${attendeeMentions.has(minutes) ? "（参加者をメンション）" : ""}`)
    .join("、") || "なし";
}

function unansweredNames(invitees, rsvps) {
  const answered = new Set(rsvps.map((rsvp) => rsvp.userId));
  const names = invitees
    .filter((invitee) => !answered.has(invitee.userId))
    .map((invitee) => safeDisplayText(invitee.displayName, 40));
  if (!names.length) return "なし";
  const joined = names.join("、");
  return joined.length > 900 ? `${joined.slice(0, 897)}…` : joined;
}

function buildRsvpRow(meeting, { includeUrl = true } = {}) {
  const inactive = meeting.status !== "active";
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`meeting:rsvp:${meeting.id}:attending`)
      .setLabel("参加")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(inactive),
    new ButtonBuilder()
      .setCustomId(`meeting:rsvp:${meeting.id}:maybe`)
      .setLabel("未定")
      .setEmoji("🤔")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(inactive),
    new ButtonBuilder()
      .setCustomId(`meeting:rsvp:${meeting.id}:declined`)
      .setLabel("欠席")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(inactive),
  );
  if (includeUrl && !inactive && meeting.meetingUrl) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("会議URLを開く")
        .setEmoji("🔗")
        .setStyle(ButtonStyle.Link)
        .setURL(meeting.meetingUrl),
    );
  }
  return row;
}

export function buildMeetingPayload(meeting, rsvps, options = {}) {
  const attendeeMentionOffsets = options.attendeeMentionOffsets ?? options.everyoneOffsets ?? [0];
  const invitees = options.invitees ?? [];
  const cancelled = meeting.status === "cancelled";
  const completed = meeting.status === "completed";
  const embed = new EmbedBuilder()
    .setColor(cancelled || completed ? 0x747f8d : 0x5865f2)
    .setTitle(`${cancelled ? "【中止】" : completed ? "【終了】" : "📅"} ${safeDisplayText(meeting.title, 100)}`)
    .setDescription([
      `**開始:** ${discordTimestamp(meeting.startsAtMs, "F")}（${discordTimestamp(meeting.startsAtMs, "R")}）`,
      `**終了予定:** ${discordTimestamp(meeting.endsAtMs, "t")}`,
      `**通知:** ${reminderText(meeting, attendeeMentionOffsets)}`,
    ].join("\n"))
    .addFields(
      { name: STATUS_LABELS.attending, value: formatNames(rsvps, "attending") },
      { name: STATUS_LABELS.maybe, value: formatNames(rsvps, "maybe") },
      { name: STATUS_LABELS.declined, value: formatNames(rsvps, "declined") },
    )
    .setFooter({ text: `会議ID: ${meeting.id} • URLはAIへ送信されません` })
    .setTimestamp(new Date(meeting.updatedAtMs));

  if (invitees.length) {
    embed.addFields({ name: "⏳ 個別招待の未回答", value: unansweredNames(invitees, rsvps) });
  }
  return { embeds: [embed], components: [buildRsvpRow(meeting)], allowedMentions: { parse: [] } };
}

export function buildDraftPayload(draft) {
  const isUpdate = draft.action === "update";
  const lines = [
    `**操作:** ${isUpdate ? `「${safeDisplayText(draft.title, 80)}」を更新` : "新しい会議を登録"}`,
  ];
  if (draft.title) {
    lines.push(`**タイトル:** ${safeDisplayText(draft.title, 100)}${draft.autoTitle ? "（名前が無かったため自動設定）" : ""}`);
  }
  if (draft.startsAtMs != null) lines.push(`**開始:** ${discordTimestamp(draft.startsAtMs, "F")}`);
  if (draft.endsAtMs != null) lines.push(`**終了予定:** ${discordTimestamp(draft.endsAtMs, "t")}`);
  if (draft.reminderMinutes) lines.push(`**通知:** ${draft.reminderMinutes.map(reminderLabel).join("、") || "なし"}`);
  lines.push(`**会議URL:** ${draft.meetingUrl ? "登録済み（GPTへは未送信）" : "変更なし"}`);
  if (draft.templateName) {
    lines.push(`**参加者テンプレート:** ${safeDisplayText(draft.templateName, 40)}（会議用に${draft.invitees?.length || 0}人を確定）`);
  }
  if (draft.invitees?.length) {
    lines.push(`**個別DM:** ${draft.invitees.map((item) => safeDisplayText(item.displayName, 40)).join("、")}`);
  } else if (draft.participantSource === "disabled") {
    lines.push("**個別DM:** 今回は送信しない");
  }

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("この内容でよいですか？")
    .setDescription(lines.join("\n"))
    .setFooter({ text: "10分以内に登録または取消を押してください" });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`meeting:draft:${draft.draftId}:confirm`)
      .setLabel(isUpdate ? "更新する" : "登録する")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`meeting:draft:${draft.draftId}:cancel`)
      .setLabel("取り消す")
      .setStyle(ButtonStyle.Secondary),
  );
  if (draft.meetingUrl) {
    row.addComponents(new ButtonBuilder().setLabel("URLを確認").setStyle(ButtonStyle.Link).setURL(draft.meetingUrl));
  }
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

export function buildDirectInvitePayload(meeting, { personalReminderMinutes = [] } = {}) {
  const cancelled = meeting.status === "cancelled";
  const completed = meeting.status === "completed";
  const description = cancelled
    ? [
      "この会議は中止になりました。以前の会議URLは開けないようにしました。",
      `**予定していた開始:** ${discordTimestamp(meeting.startsAtMs, "F")}`,
    ]
    : completed
      ? [
        "この会議は終了しました。会議URLと出欠ボタンは無効です。",
        `**開始:** ${discordTimestamp(meeting.startsAtMs, "F")}`,
      ]
      : [
      `**開始:** ${discordTimestamp(meeting.startsAtMs, "F")}（${discordTimestamp(meeting.startsAtMs, "R")}）`,
      `**終了予定:** ${discordTimestamp(meeting.endsAtMs, "t")}`,
      "**会議URL:** 下の「会議URLを開く」ボタン",
      `**あなたの個別通知:** ${formatPersonalReminderMinutes(personalReminderMinutes)}`,
      "下のボタンを押すか、このDMに「参加します」「未定です」「欠席します」のように返信してください。",
      "通知時刻は「1時間前と10分前に通知して」「今回は通知なし」のように返信すると変更できます。",
      `複数の会議がある場合は、例: \`${meeting.id} 参加\` のように会議IDも書いてください。`,
    ];
  const embed = new EmbedBuilder()
    .setColor(cancelled || completed ? 0x747f8d : 0x5865f2)
    .setTitle(`${cancelled ? "【中止】" : completed ? "【終了】" : "📨 出席確認:"} ${safeDisplayText(meeting.title, 90)}`)
    .setDescription(description.join("\n"))
    .setFooter({ text: `会議ID: ${meeting.id} • DMの回答文はGPTへ送信されません` });
  return {
    embeds: [embed],
    components: [buildRsvpRow(meeting)],
    allowedMentions: { parse: [] },
  };
}

export function buildDirectConfirmationPayload(meeting, {
  statusLabel = null,
  personalReminderMinutes = [],
  reminderUpdated = false,
  defaultSaved = false,
} = {}) {
  const lines = [
    `**会議:** ${safeDisplayText(meeting.title, 100)}`,
    `**日時:** ${discordTimestamp(meeting.startsAtMs, "F")}`,
  ];
  if (statusLabel) lines.push(`**出欠:** ${safeDisplayText(statusLabel, 20)}`);
  lines.push(`**個別通知:** ${formatPersonalReminderMinutes(personalReminderMinutes)}`);
  if (reminderUpdated) {
    lines.push(defaultSaved ? "この会議と、今後の招待に使う既定通知を更新しました。" : "この会議だけの通知を更新しました。");
  }
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ 確認しました")
    .setDescription(lines.join("\n"))
    .setFooter({ text: `会議ID: ${meeting.id} • 回答文はGPTへ送信されません` });
  const components = meeting.meetingUrl
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setLabel("会議URLを開く")
      .setEmoji("🔗")
      .setStyle(ButtonStyle.Link)
      .setURL(meeting.meetingUrl))]
    : [];
  return {
    content: statusLabel ? `確認しました。出欠は「${safeDisplayText(statusLabel, 20)}」です。` : "確認しました。個別通知を更新しました。",
    embeds: [embed],
    components,
    allowedMentions: { parse: [] },
  };
}

export function buildPersonalReminderPayload(delivery) {
  const meeting = {
    id: delivery.meetingId,
    title: delivery.title,
    startsAtMs: delivery.startsAtMs,
    endsAtMs: delivery.endsAtMs,
    meetingUrl: delivery.meetingUrl,
    status: "active",
  };
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`⏰ ${reminderLabel(delivery.offsetMinutes)}の個別通知`)
    .setDescription([
      `**会議:** ${safeDisplayText(delivery.title, 100)}`,
      `**開始:** ${discordTimestamp(delivery.startsAtMs, "F")}（${discordTimestamp(delivery.startsAtMs, "R")}）`,
      "**会議URL:** 下のボタンから開けます。",
    ].join("\n"))
    .setFooter({ text: `会議ID: ${delivery.meetingId}` });
  return { embeds: [embed], components: [buildRsvpRow(meeting)], allowedMentions: { parse: [] } };
}

export function buildNotificationPayload(delivery, rsvps) {
  const counts = {
    attending: rsvps.filter((item) => item.status === "attending").length,
    maybe: rsvps.filter((item) => item.status === "maybe").length,
    declined: rsvps.filter((item) => item.status === "declined").length,
  };
  const timing = delivery.offsetMinutes === 0 ? "開始時刻です" : `開始${reminderLabel(delivery.offsetMinutes)}です`;
  const mentionEnabled = delivery.mentionAttendees ?? delivery.mentionEveryone ?? false;
  const attendeeMention = buildAttendeeMention(rsvps, { enabled: mentionEnabled });
  const prefix = attendeeMention.content ? `${attendeeMention.content}\n` : "";
  return {
    content: `${prefix}📢 **${safeDisplayText(delivery.title, 100)}** — ${timing}\n${delivery.meetingUrl}`,
    embeds: [
      new EmbedBuilder()
        .setColor(0xed4245)
        .setDescription([
          `開始: ${discordTimestamp(delivery.startsAtMs, "F")}`,
          `出欠: 参加 ${counts.attending}名 / 未定 ${counts.maybe}名 / 欠席 ${counts.declined}名`,
          `会議ID: ${delivery.meetingId}`,
        ].join("\n")),
    ],
    allowedMentions: attendeeMention.allowedMentions,
  };
}
