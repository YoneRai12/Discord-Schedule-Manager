import { buildDirectConfirmationPayload } from "./discord-ui.mjs";
import { parseDirectMessageRsvp } from "./dm-rsvp.mjs";
import { extractMeetingId } from "./meeting-id.mjs";
import { formatPersonalReminderMinutes, parsePersonalReminderRequest } from "./personal-reminders.mjs";
import { safeDisplayText } from "./privacy.mjs";
import { discordTimestamp } from "./time.mjs";

const RSVP_LABELS = { attending: "参加", maybe: "未定", declined: "欠席" };

function meetingIdFrom(text) {
  return extractMeetingId(text);
}

function authorDisplayName(author) {
  return safeDisplayText(author?.globalName || author?.username || "Discordユーザー", 80);
}

function explicitGuildSelfService(text) {
  return Boolean(meetingIdFrom(text)) || /自分|個人|私の|通知設定|今後|毎回|今回(?:だけ)?/u.test(String(text ?? ""));
}

export class SelfServiceController {
  constructor({ store, guildId, refreshMeetingCard, sheetsSync = null, logger = console }) {
    this.store = store;
    this.guildId = String(guildId);
    this.refreshMeetingCard = refreshMeetingCard;
    this.sheetsSync = sheetsSync;
    this.logger = logger;
  }

  getPreference(userId) {
    return this.store.personalReminders.getMemberPreference(this.guildId, userId);
  }

  async showPreference(message, { privateReply = false } = {}) {
    const preference = this.getPreference(message.author.id);
    const content = preference
      ? `あなたの今後の個別通知は **${formatPersonalReminderMinutes(preference.minutes)}** です。`
      : "個人通知は未設定です。新しい招待ではサーバーの初期値を使います。";
    await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
    return true;
  }

  async setDefaultPreference(message, reminderRequest) {
    const saved = this.store.personalReminders.setMemberPreference(
      this.guildId,
      message.author.id,
      reminderRequest.minutes,
    );
    await message.reply({
      content: `確認しました。今後の個別通知を **${formatPersonalReminderMinutes(saved.minutes)}** にしました。`,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return true;
  }

  async handleMessage(message, { privateReply = false, requireExplicitTarget = false, rawText = null } = {}) {
    const content = String(rawText ?? message.content ?? "");
    const rsvp = parseDirectMessageRsvp(content);
    const reminder = parsePersonalReminderRequest(content);
    if (!rsvp && !reminder) return false;
    if (requireExplicitTarget && !explicitGuildSelfService(content)) return false;
    if (reminder?.needsClarification) {
      await message.reply({
        content: "通知時刻を確認できませんでした。例: `1時間前と10分前に通知して` / `今回は通知なし`",
        allowedMentions: { parse: [], repliedUser: false },
      });
      return true;
    }

    const invitations = this.store.listOpenInvitationsForUser(message.author.id);
    const requestedMeetingId = rsvp?.meetingId || meetingIdFrom(content);
    let meeting = requestedMeetingId
      ? invitations.find((item) => item.id === requestedMeetingId)
      : invitations.length === 1 ? invitations[0] : null;

    if (reminder?.scope === "default" && !rsvp) {
      return this.setDefaultPreference(message, reminder);
    }
    if (!meeting) {
      if (!invitations.length) {
        if (reminder && reminder.scope !== "current" && !rsvp) return this.setDefaultPreference(message, reminder);
        await message.reply({ content: "現在、あなたが回答・変更できる会議招待はありません。", allowedMentions: { parse: [] } });
        return true;
      }
      const choices = invitations.slice(0, 10)
        .map((item) => `• **${item.id}** ${safeDisplayText(item.title, 70)} — ${discordTimestamp(item.startsAtMs, "F")}`);
      await message.reply({
        content: ["対象会議を特定できません。`会議ID 参加` または `会議ID 今回は1時間前に通知` の形で書いてください。", ...choices].join("\n"),
        allowedMentions: { parse: [] },
      });
      return true;
    }

    if (rsvp) {
      const registered = this.store.getMemberAliasByUserId(this.guildId, message.author.id);
      this.store.upsertRsvp(meeting.id, {
        userId: message.author.id,
        displayName: registered?.displayName || authorDisplayName(message.author),
        status: rsvp.status,
      });
    }

    let reminderUpdated = false;
    let defaultSaved = false;
    if (reminder) {
      if (reminder.scope === "default_and_current") {
        this.store.personalReminders.setMemberPreference(this.guildId, message.author.id, reminder.minutes);
        defaultSaved = true;
      }
      if (reminder.scope !== "default") {
        this.store.personalReminders.replaceMeetingReminders({
          meetingId: meeting.id,
          userId: message.author.id,
          startsAtMs: meeting.startsAtMs,
          minutes: reminder.minutes,
          source: "override",
        });
        reminderUpdated = true;
      }
    } else if (rsvp) {
      const existing = this.store.personalReminders.getMeetingReminders(meeting.id, message.author.id);
      if (existing) {
        this.store.personalReminders.replaceMeetingReminders({
          meetingId: meeting.id,
          userId: message.author.id,
          startsAtMs: meeting.startsAtMs,
          minutes: existing.minutes,
          source: existing.source,
        });
      }
    }

    try {
      await this.refreshMeetingCard(meeting.id);
    } catch (error) {
      const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
      this.logger.warn?.(`[self-service] card_refresh_failed code=${code}`);
    }
    this.sheetsSync?.requestSync();
    const personal = this.store.personalReminders.getMeetingReminders(meeting.id, message.author.id);

    if (privateReply) {
      await message.reply(buildDirectConfirmationPayload(meeting, {
        statusLabel: rsvp ? RSVP_LABELS[rsvp.status] : null,
        personalReminderMinutes: personal?.minutes || [],
        reminderUpdated,
        defaultSaved,
      }));
    } else {
      const details = [
        `確認しました。**${meeting.id} ${safeDisplayText(meeting.title, 80)}**（${discordTimestamp(meeting.startsAtMs, "F")}）`,
      ];
      if (rsvp) details.push(`出欠: **${RSVP_LABELS[rsvp.status]}**`);
      details.push(`個別通知: **${formatPersonalReminderMinutes(personal?.minutes || [])}**`);
      details.push("会議URLは公開チャンネルへ再掲しません。招待DMのボタンから確認できます。");
      await message.reply({ content: details.join("\n"), allowedMentions: { parse: [], repliedUser: false } });
    }
    return true;
  }
}
