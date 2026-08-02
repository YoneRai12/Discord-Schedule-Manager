import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeMemberAlias } from "./participants.mjs";
import { generateMeetingId, normalizeMeetingId } from "./meeting-id.mjs";
import { discordVoiceChannelFromUrl } from "./meeting-venue.mjs";
import { AttendanceTemplateRepository } from "./storage/attendance-template-repository.mjs";
import { migrateFeatureSchema } from "./storage/feature-schema.mjs";
import { PersonalReminderRepository } from "./storage/personal-reminder-repository.mjs";
import { normalizeReminderMinutes } from "./time.mjs";

const RSVP_STATUSES = new Set(["attending", "maybe", "declined"]);

function updateConflict() {
  return Object.assign(new Error("会議が別の操作で更新されました。最新状態を確認してやり直してください"), {
    code: "meeting_update_conflict",
  });
}

function corruptReminderJson() {
  return Object.assign(new Error("保存済みの通知設定が破損しています"), {
    code: "corrupt_reminder_json",
  });
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) throw corruptReminderJson();
    if (parsed.some((item) => !Number.isSafeInteger(Number(item)) || Number(item) < 0 || Number(item) > 10_080)) {
      throw corruptReminderJson();
    }
    return parsed;
  } catch {
    throw corruptReminderJson();
  }
}

function mapMeeting(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id || null,
    createdById: row.created_by_id,
    createdByName: row.created_by_name,
    title: row.title,
    startsAtMs: Number(row.starts_at_ms),
    endsAtMs: Number(row.ends_at_ms),
    timeZone: row.time_zone,
    meetingUrl: row.meeting_url,
    voiceChannelId: row.voice_channel_id || null,
    voiceAutoRecord: Boolean(row.voice_auto_record),
    voiceAutoStartedAtMs: row.voice_auto_started_at_ms == null ? null : Number(row.voice_auto_started_at_ms),
    voiceAutoSessionId: row.voice_auto_session_id || null,
    status: row.status,
    scheduleRevision: Number(row.schedule_revision || 0),
    cardRevision: Number(row.card_revision || 0),
    reminderMinutes: parseJsonArray(row.reminder_minutes_json).map(Number),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function mapRsvp(row) {
  return {
    meetingId: row.meeting_id,
    userId: row.user_id,
    displayName: row.display_name,
    status: row.status,
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function mapDelivery(row) {
  return {
    meetingId: row.meeting_id,
    offsetMinutes: Number(row.offset_minutes),
    dueAtMs: Number(row.due_at_ms),
    // 既存DBを移行なしで使えるよう、SQLiteの旧カラム名は維持する。
    // trueは現在「参加者だけをメンションする時刻」を意味する。
    mentionAttendees: Boolean(row.mention_everyone),
    status: row.status,
    scheduleRevision: Number(row.schedule_revision || 0),
    attempts: Number(row.attempts),
    claimToken: row.claim_token || null,
    discordMessageId: row.discord_message_id || null,
    sentAtMs: row.sent_at_ms == null ? null : Number(row.sent_at_ms),
  };
}

function mapMemberAlias(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    alias: row.alias,
    aliasKey: row.alias_key,
    userId: row.user_id,
    displayName: row.display_name,
    createdById: row.created_by_id,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function mapInvitee(row) {
  if (!row) return null;
  return {
    meetingId: row.meeting_id,
    userId: row.user_id,
    displayName: row.display_name,
    invitedById: row.invited_by_id,
    deliveryStatus: row.delivery_status,
    deliveryErrorCode: row.delivery_error_code || null,
    dmMessageId: row.dm_message_id || null,
    createdAtMs: Number(row.created_at_ms),
    deliveredAtMs: row.delivered_at_ms == null ? null : Number(row.delivered_at_ms),
  };
}

export class MeetingDatabase {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    const transaction = this.transaction.bind(this);
    migrateFeatureSchema(this.db, transaction);
    this.attendanceTemplates = new AttendanceTemplateRepository({ db: this.db, transaction });
    this.personalReminders = new PersonalReminderRepository({
      db: this.db,
      transaction,
      completeEndedMeetings: ({ nowMs }) => this.completeEndedMeetings({ nowMs }),
    });
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        created_by_id TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        title TEXT NOT NULL,
        starts_at_ms INTEGER NOT NULL,
        ends_at_ms INTEGER NOT NULL,
        time_zone TEXT NOT NULL,
        meeting_url TEXT NOT NULL,
        voice_channel_id TEXT,
        voice_auto_record INTEGER NOT NULL DEFAULT 0 CHECK(voice_auto_record IN (0, 1)),
        voice_auto_started_at_ms INTEGER,
        voice_auto_session_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'cancelled', 'completed')),
        schedule_revision INTEGER NOT NULL DEFAULT 0 CHECK(schedule_revision >= 0),
        card_revision INTEGER NOT NULL DEFAULT 0 CHECK(card_revision >= 0),
        reminder_minutes_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meetings_start_idx ON meetings(status, starts_at_ms);
      CREATE TABLE IF NOT EXISTS rsvps (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('attending', 'maybe', 'declined')),
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(meeting_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS member_aliases (
        guild_id TEXT NOT NULL,
        alias_key TEXT NOT NULL,
        alias TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_by_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(guild_id, alias_key)
      );
      CREATE INDEX IF NOT EXISTS member_aliases_user_idx ON member_aliases(guild_id, user_id);
      CREATE TABLE IF NOT EXISTS meeting_invitees (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        invited_by_id TEXT NOT NULL,
        delivery_status TEXT NOT NULL CHECK(delivery_status IN ('pending', 'sent', 'failed')),
        delivery_error_code TEXT,
        dm_message_id TEXT,
        created_at_ms INTEGER NOT NULL,
        delivered_at_ms INTEGER,
        PRIMARY KEY(meeting_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS invitees_user_idx
        ON meeting_invitees(user_id, meeting_id);
      CREATE TABLE IF NOT EXISTS direct_invite_sends (
        meeting_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        target_updated_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        lease_expires_at_ms INTEGER,
        claim_token TEXT,
        last_error_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(meeting_id, user_id),
        FOREIGN KEY(meeting_id, user_id)
          REFERENCES meeting_invitees(meeting_id, user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS direct_invite_sends_due_idx
        ON direct_invite_sends(status, next_attempt_at_ms, updated_at_ms);
      CREATE TABLE IF NOT EXISTS direct_invite_updates (
        meeting_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        target_updated_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'skipped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        lease_expires_at_ms INTEGER,
        claim_token TEXT,
        last_error_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(meeting_id, user_id),
        FOREIGN KEY(meeting_id, user_id)
          REFERENCES meeting_invitees(meeting_id, user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS direct_invite_updates_due_idx
        ON direct_invite_updates(status, next_attempt_at_ms, updated_at_ms);
      CREATE TABLE IF NOT EXISTS meeting_card_updates (
        meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        target_card_revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'skipped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        lease_expires_at_ms INTEGER,
        claim_token TEXT,
        last_error_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meeting_card_updates_due_idx
        ON meeting_card_updates(status, next_attempt_at_ms, updated_at_ms);
      CREATE TABLE IF NOT EXISTS deliveries (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        schedule_revision INTEGER NOT NULL DEFAULT 0 CHECK(schedule_revision >= 0),
        offset_minutes INTEGER NOT NULL,
        due_at_ms INTEGER NOT NULL,
        mention_everyone INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'skipped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        lease_expires_at_ms INTEGER,
        claim_token TEXT,
        discord_message_id TEXT,
        last_error_code TEXT,
        sent_at_ms INTEGER,
        PRIMARY KEY(meeting_id, schedule_revision, offset_minutes)
      );
      CREATE INDEX IF NOT EXISTS deliveries_due_idx
        ON deliveries(status, next_attempt_at_ms, due_at_ms);
    `);
    this.migrateMeetingScheduleRevision();
    this.migrateMeetingCardRevision();
    this.migrateMeetingVoiceAutomation();
    this.migrateGroupDeliverySchema();
    this.migrateMemberAliasSchema();
  }

  tableColumns(tableName) {
    return new Set(this.db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
  }

  migrateMemberAliasSchema() {
    const table = this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'member_aliases'
    `).get();
    if (/UNIQUE\s*\(\s*guild_id\s*,\s*user_id\s*\)/iu.test(String(table?.sql ?? ""))) {
      this.transaction(() => {
        this.db.exec(`
          DROP INDEX IF EXISTS member_aliases_user_idx;
          ALTER TABLE member_aliases RENAME TO member_aliases_single_alias;
          CREATE TABLE member_aliases (
            guild_id TEXT NOT NULL,
            alias_key TEXT NOT NULL,
            alias TEXT NOT NULL,
            user_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            created_by_id TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY(guild_id, alias_key)
          );
          INSERT INTO member_aliases(
            guild_id, alias_key, alias, user_id, display_name, created_by_id,
            created_at_ms, updated_at_ms
          )
          SELECT guild_id, alias_key, alias, user_id, display_name, created_by_id,
                 created_at_ms, updated_at_ms
          FROM member_aliases_single_alias;
          DROP TABLE member_aliases_single_alias;
        `);
      });
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS member_aliases_user_idx ON member_aliases(guild_id, user_id);");
  }

  migrateMeetingScheduleRevision() {
    if (this.tableColumns("meetings").has("schedule_revision")) return;
    this.db.exec(`
      ALTER TABLE meetings
      ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 0 CHECK(schedule_revision >= 0);
    `);
  }

  migrateMeetingCardRevision() {
    if (this.tableColumns("meetings").has("card_revision")) return;
    this.db.exec(`
      ALTER TABLE meetings
      ADD COLUMN card_revision INTEGER NOT NULL DEFAULT 0 CHECK(card_revision >= 0);
    `);
  }

  migrateMeetingVoiceAutomation() {
    const columns = this.tableColumns("meetings");
    if (!columns.has("voice_channel_id")) this.db.exec("ALTER TABLE meetings ADD COLUMN voice_channel_id TEXT;");
    if (!columns.has("voice_auto_record")) {
      this.db.exec("ALTER TABLE meetings ADD COLUMN voice_auto_record INTEGER NOT NULL DEFAULT 0 CHECK(voice_auto_record IN (0, 1));");
    }
    if (!columns.has("voice_auto_started_at_ms")) this.db.exec("ALTER TABLE meetings ADD COLUMN voice_auto_started_at_ms INTEGER;");
    if (!columns.has("voice_auto_session_id")) this.db.exec("ALTER TABLE meetings ADD COLUMN voice_auto_session_id TEXT;");

    const rows = this.db.prepare(`
      SELECT id, guild_id, meeting_url FROM meetings
      WHERE voice_channel_id IS NULL AND meeting_url != ''
    `).all();
    const update = this.db.prepare(`
      UPDATE meetings SET voice_channel_id = ?, voice_auto_record = 1
      WHERE id = ? AND guild_id = ? AND voice_channel_id IS NULL
    `);
    for (const row of rows) {
      const voice = discordVoiceChannelFromUrl(row.meeting_url);
      if (voice?.guildId === String(row.guild_id)) update.run(voice.channelId, row.id, row.guild_id);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS meetings_voice_auto_idx
      ON meetings(guild_id, voice_channel_id, voice_auto_record, voice_auto_started_at_ms, starts_at_ms);
    `);
  }

  migrateGroupDeliverySchema() {
    const columns = this.tableColumns("deliveries");
    if (columns.has("schedule_revision") && columns.has("claim_token")) return;
    const revisionExpression = columns.has("schedule_revision")
      ? "schedule_revision"
      : "COALESCE((SELECT schedule_revision FROM meetings WHERE meetings.id = deliveries.meeting_id), 0)";
    const claimExpression = columns.has("claim_token") ? "claim_token" : "NULL";
    this.transaction(() => {
      this.db.exec(`
        DROP INDEX IF EXISTS deliveries_due_idx;
        ALTER TABLE deliveries RENAME TO deliveries_before_revision;
        CREATE TABLE deliveries (
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          schedule_revision INTEGER NOT NULL DEFAULT 0 CHECK(schedule_revision >= 0),
          offset_minutes INTEGER NOT NULL,
          due_at_ms INTEGER NOT NULL,
          mention_everyone INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'skipped')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
          lease_expires_at_ms INTEGER,
          claim_token TEXT,
          discord_message_id TEXT,
          last_error_code TEXT,
          sent_at_ms INTEGER,
          PRIMARY KEY(meeting_id, schedule_revision, offset_minutes)
        );
        INSERT INTO deliveries(
          meeting_id, schedule_revision, offset_minutes, due_at_ms, mention_everyone,
          status, attempts, next_attempt_at_ms, lease_expires_at_ms, claim_token,
          discord_message_id, last_error_code, sent_at_ms
        )
        SELECT
          meeting_id, ${revisionExpression}, offset_minutes, due_at_ms, mention_everyone,
          status, attempts, next_attempt_at_ms, lease_expires_at_ms, ${claimExpression},
          discord_message_id, last_error_code, sent_at_ms
        FROM deliveries_before_revision AS deliveries;
        DROP TABLE deliveries_before_revision;
        CREATE INDEX deliveries_due_idx
          ON deliveries(status, next_attempt_at_ms, due_at_ms);
      `);
    });
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bindTenant({ guildId, botUserId }) {
    const expected = { guild_id: String(guildId), bot_user_id: String(botUserId) };
    this.transaction(() => {
      for (const [key, value] of Object.entries(expected)) {
        const current = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
        if (current && current.value !== value) {
          throw new Error(`保存済みのDiscordテナントと一致しません: ${key}`);
        }
        this.db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)").run(key, value);
      }
    });
  }

  generateMeetingId() {
    return generateMeetingId({ exists: (id) => Boolean(this.getMeeting(id)) });
  }

  createMeeting(input) {
    const now = Date.now();
    const id = input.id ? normalizeMeetingId(input.id) : this.generateMeetingId();
    const reminders = normalizeReminderMinutes(input.reminderMinutes);
    const messageId = input.messageId ? String(input.messageId) : null;
    const meetingUrl = String(input.meetingUrl ?? "").trim();
    const voiceTarget = discordVoiceChannelFromUrl(meetingUrl);
    const voiceChannelId = voiceTarget?.guildId === String(input.guildId) ? voiceTarget.channelId : null;
    const voiceAutoRecord = voiceChannelId && input.voiceAutoRecord !== false ? 1 : 0;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO meetings(
          id, guild_id, channel_id, message_id, created_by_id, created_by_name,
          title, starts_at_ms, ends_at_ms, time_zone, meeting_url,
          voice_channel_id, voice_auto_record, status,
          reminder_minutes_json, created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        id,
        String(input.guildId),
        String(input.channelId),
        messageId,
        String(input.createdById),
        input.createdByName,
        input.title,
        Number(input.startsAtMs),
        Number(input.endsAtMs),
        input.timeZone || "Asia/Tokyo",
        meetingUrl,
        voiceChannelId,
        voiceAutoRecord,
        JSON.stringify(reminders),
        now,
        now,
      );
      const attendeeMentionOffsets = input.attendeeMentionOffsets ?? input.everyoneOffsets ?? [0];
      this.replacePendingDeliveries(id, Number(input.startsAtMs), reminders, attendeeMentionOffsets, {
        scheduleRevision: 0,
      });
      if (messageId) this.queueMeetingCardUpdateInternal(id, 0, now);
    });
    return this.getMeeting(id);
  }

  replacePendingDeliveries(
    meetingId,
    startsAtMs,
    reminders,
    attendeeMentionOffsets,
    { scheduleRevision = null } = {},
  ) {
    const revision = scheduleRevision ?? this.getMeeting(meetingId)?.scheduleRevision ?? 0;
    const offsets = normalizeReminderMinutes(reminders);
    const desired = new Set(offsets);
    const existing = this.db.prepare(`
      SELECT offset_minutes, status FROM deliveries
      WHERE meeting_id = ? AND schedule_revision = ?
    `).all(meetingId, revision);
    const skip = this.db.prepare(`
      UPDATE deliveries
      SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
          last_error_code = 'schedule_changed'
      WHERE meeting_id = ? AND schedule_revision = ? AND offset_minutes = ?
        AND status IN ('pending', 'sending')
    `);
    for (const row of existing) {
      if (!desired.has(Number(row.offset_minutes))) {
        skip.run(meetingId, revision, row.offset_minutes);
      }
    }
    const statement = this.db.prepare(`
      INSERT INTO deliveries(
        meeting_id, schedule_revision, offset_minutes, due_at_ms,
        mention_everyone, status, next_attempt_at_ms
      ) VALUES(?, ?, ?, ?, ?, 'pending', 0)
      ON CONFLICT(meeting_id, schedule_revision, offset_minutes) DO UPDATE SET
        due_at_ms = excluded.due_at_ms,
        mention_everyone = excluded.mention_everyone,
        status = CASE
          WHEN deliveries.status IN ('sent', 'sending') THEN deliveries.status
          ELSE 'pending'
        END,
        attempts = CASE WHEN deliveries.status = 'skipped' THEN 0 ELSE deliveries.attempts END,
        next_attempt_at_ms = CASE WHEN deliveries.status = 'skipped' THEN 0 ELSE deliveries.next_attempt_at_ms END,
        lease_expires_at_ms = CASE WHEN deliveries.status = 'sending' THEN deliveries.lease_expires_at_ms ELSE NULL END,
        claim_token = CASE WHEN deliveries.status = 'sending' THEN deliveries.claim_token ELSE NULL END,
        last_error_code = CASE WHEN deliveries.status IN ('sent', 'sending') THEN deliveries.last_error_code ELSE NULL END
    `);
    const attendeeMentionSet = new Set(attendeeMentionOffsets.map(Number));
    for (const offset of offsets) {
      statement.run(
        meetingId,
        revision,
        offset,
        startsAtMs - offset * 60_000,
        attendeeMentionSet.has(offset) ? 1 : 0,
      );
    }
  }

  updateMeeting(id, patch, options = {}) {
    const attendeeMentionOffsets = options.attendeeMentionOffsets ?? options.everyoneOffsets ?? [0];
    return this.updateMeetingInternal(id, patch, { attendeeMentionOffsets });
  }

  updateMeetingIfUnchanged(id, patch, options = {}) {
    const { expectedUpdatedAtMs } = options;
    const attendeeMentionOffsets = options.attendeeMentionOffsets ?? options.everyoneOffsets ?? [0];
    if (!Number.isSafeInteger(Number(expectedUpdatedAtMs))) throw updateConflict();
    return this.updateMeetingInternal(id, patch, {
      attendeeMentionOffsets,
      expectedUpdatedAtMs: Number(expectedUpdatedAtMs),
    });
  }

  updateMeetingInternal(
    id,
    patch,
    { attendeeMentionOffsets = [0], expectedUpdatedAtMs = null } = {},
  ) {
    const current = this.getMeeting(id);
    if (!current) throw new Error("会議が見つかりません");
    if (current.status !== "active") throw new Error("終了または中止済みの会議は更新できません");
    if (expectedUpdatedAtMs != null && current.updatedAtMs !== expectedUpdatedAtMs) throw updateConflict();
    const next = {
      title: patch.title ?? current.title,
      startsAtMs: patch.startsAtMs ?? current.startsAtMs,
      endsAtMs: patch.endsAtMs ?? current.endsAtMs,
      meetingUrl: patch.meetingUrl ?? current.meetingUrl,
      reminderMinutes: normalizeReminderMinutes(patch.reminderMinutes ?? current.reminderMinutes),
    };
    const voiceTarget = discordVoiceChannelFromUrl(next.meetingUrl);
    const voiceChannelId = voiceTarget?.guildId === current.guildId ? voiceTarget.channelId : null;
    const voiceAutoRecord = voiceChannelId
      ? Object.hasOwn(patch, "voiceAutoRecord")
        ? (patch.voiceAutoRecord ? 1 : 0)
        : voiceChannelId === current.voiceChannelId ? (current.voiceAutoRecord ? 1 : 0) : 1
      : 0;
    const startsAtChanged = next.startsAtMs !== current.startsAtMs;
    const voiceScheduleChanged = startsAtChanged || voiceChannelId !== current.voiceChannelId;
    const remindersChanged = JSON.stringify(next.reminderMinutes) !== JSON.stringify(current.reminderMinutes);
    const nextRevision = startsAtChanged ? current.scheduleRevision + 1 : current.scheduleRevision;
    const nextUpdatedAtMs = Math.max(Date.now(), current.updatedAtMs + 1);
    this.transaction(() => {
      const update = this.db.prepare(`
        UPDATE meetings
        SET title = ?, starts_at_ms = ?, ends_at_ms = ?, meeting_url = ?,
            voice_channel_id = ?, voice_auto_record = ?,
            voice_auto_started_at_ms = CASE WHEN ? = 1 THEN NULL ELSE voice_auto_started_at_ms END,
            voice_auto_session_id = CASE WHEN ? = 1 THEN NULL ELSE voice_auto_session_id END,
            reminder_minutes_json = ?, schedule_revision = ?, card_revision = card_revision + 1,
            updated_at_ms = ?
        WHERE id = ? AND status = 'active' AND updated_at_ms = ?
      `).run(
        next.title,
        next.startsAtMs,
        next.endsAtMs,
        next.meetingUrl,
        voiceChannelId,
        voiceAutoRecord,
        voiceScheduleChanged ? 1 : 0,
        voiceScheduleChanged ? 1 : 0,
        JSON.stringify(next.reminderMinutes),
        nextRevision,
        nextUpdatedAtMs,
        id,
        current.updatedAtMs,
      );
      if (update.changes !== 1) throw updateConflict();
      if (startsAtChanged) {
        this.db.prepare(`
          UPDATE deliveries
          SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
              last_error_code = 'schedule_superseded'
          WHERE meeting_id = ? AND schedule_revision != ?
            AND status IN ('pending', 'sending')
        `).run(id, nextRevision);
      }
      if (startsAtChanged || remindersChanged) {
        this.replacePendingDeliveries(id, next.startsAtMs, next.reminderMinutes, attendeeMentionOffsets, {
          scheduleRevision: nextRevision,
        });
      }
      if (startsAtChanged) {
        for (const invitee of this.listMeetingInvitees(id)) {
          const personal = this.personalReminders.getMeetingReminders(id, invitee.userId);
          if (!personal) continue;
          this.personalReminders.replaceMeetingRemindersInternal({
            meetingId: id,
            userId: invitee.userId,
            startsAtMs: next.startsAtMs,
            minutes: personal.minutes,
            source: personal.source,
            nowMs: nextUpdatedAtMs,
          });
        }
      }
      this.invalidateSendingDeliveryClaimsInternal(id, nextUpdatedAtMs);
      this.personalReminders.invalidateSendingClaimsForMeeting(id, { nowMs: nextUpdatedAtMs });
      this.queueMeetingCardUpdateInternal(id, current.cardRevision + 1, nextUpdatedAtMs);
      this.retargetDirectInviteSendsInternal(id, nextUpdatedAtMs, nextUpdatedAtMs);
      this.queueDirectInviteUpdatesInternal(id, nextUpdatedAtMs, nextUpdatedAtMs);
    });
    return this.getMeeting(id);
  }

  updateMeetingUrl(id, meetingUrl) {
    return this.updateMeetingUrlInternal(id, meetingUrl);
  }

  updateMeetingUrlIfUnchanged(id, meetingUrl, { expectedUpdatedAtMs } = {}) {
    if (!Number.isSafeInteger(Number(expectedUpdatedAtMs))) throw updateConflict();
    return this.updateMeetingUrlInternal(id, meetingUrl, {
      expectedUpdatedAtMs: Number(expectedUpdatedAtMs),
    });
  }

  updateMeetingUrlInternal(id, meetingUrl, { expectedUpdatedAtMs = null } = {}) {
    const normalizedId = normalizeMeetingId(id);
    const current = this.getMeeting(normalizedId);
    if (!current) throw new Error("会議が見つかりません");
    if (current.status !== "active") throw new Error("終了または中止済みの会議は更新できません");
    if (expectedUpdatedAtMs != null && current.updatedAtMs !== expectedUpdatedAtMs) throw updateConflict();
    const normalizedUrl = String(meetingUrl ?? "").trim();
    const voiceTarget = discordVoiceChannelFromUrl(normalizedUrl);
    const voiceChannelId = voiceTarget?.guildId === current.guildId ? voiceTarget.channelId : null;
    const voiceAutoRecord = voiceChannelId
      ? voiceChannelId === current.voiceChannelId ? (current.voiceAutoRecord ? 1 : 0) : 1
      : 0;
    const voiceScheduleChanged = voiceChannelId !== current.voiceChannelId;
    const nextUpdatedAtMs = Math.max(Date.now(), current.updatedAtMs + 1);
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE meetings SET meeting_url = ?, voice_channel_id = ?, voice_auto_record = ?,
          voice_auto_started_at_ms = CASE WHEN ? = 1 THEN NULL ELSE voice_auto_started_at_ms END,
          voice_auto_session_id = CASE WHEN ? = 1 THEN NULL ELSE voice_auto_session_id END,
          card_revision = card_revision + 1, updated_at_ms = ?
        WHERE id = ? AND status = 'active' AND updated_at_ms = ?
      `).run(
        normalizedUrl,
        voiceChannelId,
        voiceAutoRecord,
        voiceScheduleChanged ? 1 : 0,
        voiceScheduleChanged ? 1 : 0,
        nextUpdatedAtMs,
        normalizedId,
        current.updatedAtMs,
      );
      if (result.changes !== 1) throw updateConflict();
      this.invalidateSendingDeliveryClaimsInternal(normalizedId, nextUpdatedAtMs);
      this.personalReminders.invalidateSendingClaimsForMeeting(normalizedId, { nowMs: nextUpdatedAtMs });
      this.queueMeetingCardUpdateInternal(normalizedId, current.cardRevision + 1, nextUpdatedAtMs);
      this.retargetDirectInviteSendsInternal(normalizedId, nextUpdatedAtMs, nextUpdatedAtMs);
      this.queueDirectInviteUpdatesInternal(normalizedId, nextUpdatedAtMs, nextUpdatedAtMs);
    });
    return this.getMeeting(normalizedId);
  }

  setMessageId(id, messageId) {
    this.db.prepare("UPDATE meetings SET message_id = ?, updated_at_ms = ? WHERE id = ?")
      .run(String(messageId), Date.now(), id);
  }

  cancelMeeting(id) {
    const current = this.getMeeting(id);
    if (!current || current.status !== "active") return null;
    const now = Math.max(Date.now(), current.updatedAtMs + 1);
    const result = this.transaction(() => {
      const updated = this.db.prepare(`
        UPDATE meetings
        SET status = 'cancelled', card_revision = card_revision + 1,
            updated_at_ms = MAX(?, updated_at_ms + 1)
        WHERE id = ? AND status = 'active'
        RETURNING card_revision, updated_at_ms
      `).get(now, id);
      this.db.prepare(`
        UPDATE deliveries
        SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
            last_error_code = 'meeting_cancelled'
        WHERE meeting_id = ? AND status IN ('pending', 'sending')
      `)
        .run(id);
      this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
            last_error_code = 'meeting_cancelled', updated_at_ms = ?
        WHERE meeting_id = ? AND status IN ('pending', 'sending')
      `).run(now, id);
      if (updated) {
        const committedAtMs = Number(updated.updated_at_ms);
        this.queueMeetingCardUpdateInternal(id, Number(updated.card_revision), committedAtMs);
        this.retargetDirectInviteSendsInternal(id, committedAtMs, committedAtMs);
        this.queueDirectInviteUpdatesInternal(id, committedAtMs, committedAtMs);
      }
      return updated ? 1 : 0;
    });
    return result > 0 ? this.getMeeting(id) : null;
  }

  completeEndedMeetings({ nowMs = Date.now() } = {}) {
    const now = Number(nowMs);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("現在日時が正しくありません");
    return this.transaction(() => this.completeEndedMeetingsInternal(now));
  }

  completeEndedMeetingsInternal(nowMs) {
    const rows = this.db.prepare(`
      SELECT id, card_revision, updated_at_ms
      FROM meetings
      WHERE status = 'active' AND ends_at_ms < ?
      ORDER BY ends_at_ms ASC
    `).all(nowMs);
    let ended = 0;
    const update = this.db.prepare(`
      UPDATE meetings
      SET status = 'completed', card_revision = card_revision + 1, updated_at_ms = ?
      WHERE id = ? AND status = 'active' AND updated_at_ms = ?
    `);
    for (const row of rows) {
      const nextUpdatedAtMs = Math.max(Number(nowMs), Number(row.updated_at_ms) + 1);
      if (update.run(nextUpdatedAtMs, row.id, row.updated_at_ms).changes !== 1) continue;
      ended += 1;
      this.queueMeetingCardUpdateInternal(row.id, Number(row.card_revision) + 1, nextUpdatedAtMs);
      this.retargetDirectInviteSendsInternal(row.id, nextUpdatedAtMs, nextUpdatedAtMs);
      this.queueDirectInviteUpdatesInternal(row.id, nextUpdatedAtMs, nextUpdatedAtMs);
    }
    if (!ended) return 0;
    this.db.prepare(`
      UPDATE deliveries
      SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
          last_error_code = 'meeting_completed'
      WHERE status IN ('pending', 'sending')
        AND EXISTS (
          SELECT 1 FROM meetings m
          WHERE m.id = deliveries.meeting_id AND m.status = 'completed'
        )
    `).run();
    this.db.prepare(`
      UPDATE personal_deliveries
      SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
          last_error_code = 'meeting_completed', updated_at_ms = ?
      WHERE status IN ('pending', 'sending')
        AND EXISTS (
          SELECT 1 FROM meetings m
          WHERE m.id = personal_deliveries.meeting_id AND m.status = 'completed'
        )
    `).run(nowMs);
    return ended;
  }

  getMeeting(id) {
    return mapMeeting(this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(String(id).toUpperCase()));
  }

  getMeetingByMessageId(guildId, channelId, messageId) {
    if (!messageId) return null;
    const row = channelId
      ? this.db.prepare(`
          SELECT * FROM meetings
          WHERE guild_id = ? AND channel_id = ? AND message_id = ?
          LIMIT 1
        `).get(String(guildId), String(channelId), String(messageId))
      : this.db.prepare(`
          SELECT * FROM meetings
          WHERE guild_id = ? AND message_id = ?
          LIMIT 1
        `).get(String(guildId), String(messageId));
    return mapMeeting(row);
  }

  listUpcoming(guildId, { limit = 20, nowMs = Date.now() } = {}) {
    return this.db.prepare(`
      SELECT * FROM meetings
      WHERE guild_id = ? AND status = 'active' AND ends_at_ms >= ?
      ORDER BY starts_at_ms ASC LIMIT ?
    `).all(String(guildId), nowMs, limit).map(mapMeeting);
  }

  listVoiceAutoStartCandidates(guildId, {
    nowMs = Date.now(),
    earlyMinutes = 15,
    limit = 20,
  } = {}) {
    const latestStartMs = Number(nowMs) + Math.max(0, Number(earlyMinutes) || 0) * 60_000;
    return this.db.prepare(`
      SELECT * FROM meetings
      WHERE guild_id = ? AND status = 'active'
        AND voice_auto_record = 1 AND voice_channel_id IS NOT NULL
        AND voice_auto_started_at_ms IS NULL
        AND starts_at_ms <= ? AND ends_at_ms >= ?
      ORDER BY starts_at_ms ASC, created_at_ms ASC
      LIMIT ?
    `).all(String(guildId), latestStartMs, Number(nowMs), Math.max(1, Number(limit) || 20)).map(mapMeeting);
  }

  claimVoiceAutoStart(id, claimToken, {
    nowMs = Date.now(),
    earlyMinutes = 15,
    expectedUpdatedAtMs = null,
    expectedVoiceChannelId = null,
  } = {}) {
    const token = `claim:${String(claimToken ?? "").trim()}`;
    if (!/^claim:[A-Za-z0-9_-]{8,80}$/u.test(token)) throw new Error("VC自動開始claimの形式が正しくありません");
    const normalizedId = normalizeMeetingId(id);
    const snapshot = this.getMeeting(normalizedId);
    if (!snapshot) return false;
    const expectedRevision = expectedUpdatedAtMs == null
      ? snapshot.updatedAtMs
      : Number(expectedUpdatedAtMs);
    const expectedChannel = String(expectedVoiceChannelId ?? snapshot.voiceChannelId ?? "").trim();
    if (!Number.isSafeInteger(expectedRevision) || !expectedChannel) return false;
    const currentMs = Number(nowMs);
    const leadMs = Math.max(0, Number(earlyMinutes) || 0) * 60_000;
    if (!Number.isSafeInteger(currentMs) || !Number.isSafeInteger(leadMs)) return false;
    const result = this.db.prepare(`
      UPDATE meetings
      SET voice_auto_started_at_ms = ?, voice_auto_session_id = ?
      WHERE id = ? AND status = 'active' AND voice_auto_record = 1
        AND voice_channel_id = ? AND updated_at_ms = ?
        AND voice_auto_started_at_ms IS NULL
        AND starts_at_ms <= ? AND ends_at_ms >= ?
    `).run(
      currentMs,
      token,
      normalizedId,
      expectedChannel,
      expectedRevision,
      currentMs + leadMs,
      currentMs,
    );
    return result.changes === 1;
  }

  finalizeVoiceAutoStart(id, claimToken, sessionId, { nowMs = Date.now() } = {}) {
    const token = `claim:${String(claimToken ?? "").trim()}`;
    const normalizedId = normalizeMeetingId(id);
    const current = this.getMeeting(normalizedId);
    if (!current) throw new Error("会議が見つかりません");
    const updatedAtMs = Math.max(Number(nowMs), current.updatedAtMs + 1);
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE meetings
        SET voice_auto_session_id = ?, card_revision = card_revision + 1, updated_at_ms = ?
        WHERE id = ? AND voice_auto_session_id = ?
      `).run(String(sessionId), updatedAtMs, normalizedId, token);
      if (result.changes !== 1) return false;
      this.queueMeetingCardUpdateInternal(normalizedId, current.cardRevision + 1, updatedAtMs);
      return true;
    });
  }

  isVoiceAutoSessionCurrent(id, sessionId, {
    voiceChannelId,
    nowMs = Date.now(),
    earlyMinutes = 15,
  } = {}) {
    const normalizedId = normalizeMeetingId(id);
    const session = String(sessionId ?? "").trim();
    const channel = String(voiceChannelId ?? "").trim();
    const currentMs = Number(nowMs);
    const leadMs = Math.max(0, Number(earlyMinutes) || 0) * 60_000;
    if (!session || session.startsWith("claim:") || !channel) return false;
    if (!Number.isSafeInteger(currentMs) || !Number.isSafeInteger(leadMs)) return false;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM meetings
      WHERE id = ? AND voice_auto_session_id = ? AND voice_channel_id = ?
        AND status = 'active' AND voice_auto_record = 1
        AND starts_at_ms <= ? AND ends_at_ms >= ?
      LIMIT 1
    `).get(normalizedId, session, channel, currentMs + leadMs, currentMs));
  }

  releaseVoiceAutoStart(id, sessionId, { expectedVoiceChannelId = null } = {}) {
    const rawSession = String(sessionId ?? "").trim();
    if (!rawSession) return false;
    const storedSession = rawSession.startsWith("claim:")
      ? rawSession
      : /^[A-Fa-f0-9]{10}$/u.test(rawSession)
        ? rawSession.toUpperCase()
        : `claim:${rawSession}`;
    const expectedChannel = String(expectedVoiceChannelId ?? "").trim();
    const result = this.db.prepare(`
      UPDATE meetings
      SET voice_auto_started_at_ms = NULL, voice_auto_session_id = NULL
      WHERE id = ? AND voice_auto_session_id = ?
        AND (? = '' OR voice_channel_id = ?)
    `).run(normalizeMeetingId(id), storedSession, expectedChannel, expectedChannel);
    return result.changes === 1;
  }

  recoverStaleVoiceAutoClaims({ nowMs = Date.now(), staleAfterMs = 5 * 60_000 } = {}) {
    const cutoff = Number(nowMs) - Math.max(60_000, Number(staleAfterMs) || 5 * 60_000);
    return this.db.prepare(`
      UPDATE meetings
      SET voice_auto_started_at_ms = NULL, voice_auto_session_id = NULL
      WHERE voice_auto_session_id LIKE 'claim:%' AND voice_auto_started_at_ms <= ?
    `).run(cutoff).changes;
  }

  listFinalizedVoiceAutoStarts(guildId, { limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT * FROM meetings
      WHERE guild_id = ? AND status = 'active' AND voice_auto_record = 1
        AND voice_channel_id IS NOT NULL
        AND voice_auto_session_id IS NOT NULL
        AND voice_auto_session_id NOT LIKE 'claim:%'
      ORDER BY voice_auto_started_at_ms ASC, starts_at_ms ASC
      LIMIT ?
    `).all(String(guildId), Math.max(1, Number(limit) || 100)).map(mapMeeting);
  }

  listActiveMeetingIds(guildId, { nowMs = Date.now() } = {}) {
    return this.db.prepare(`
      SELECT id FROM meetings
      WHERE guild_id = ? AND status = 'active' AND ends_at_ms >= ?
      ORDER BY starts_at_ms ASC
    `).all(String(guildId), Number(nowMs)).map((row) => String(row.id));
  }

  listActiveMeetingsByChannel(guildId, channelId, { limit = 20, nowMs = Date.now() } = {}) {
    return this.db.prepare(`
      SELECT * FROM meetings
      WHERE guild_id = ? AND channel_id = ? AND status = 'active' AND ends_at_ms >= ?
      ORDER BY starts_at_ms ASC, created_at_ms DESC LIMIT ?
    `).all(String(guildId), String(channelId), nowMs, limit).map(mapMeeting);
  }

  listRecentActiveMeetingsByCreator(guildId, channelId, createdById, { limit = 5, nowMs = Date.now() } = {}) {
    return this.db.prepare(`
      SELECT * FROM meetings
      WHERE guild_id = ? AND channel_id = ? AND created_by_id = ?
        AND status = 'active' AND ends_at_ms >= ?
      ORDER BY created_at_ms DESC, updated_at_ms DESC LIMIT ?
    `).all(String(guildId), String(channelId), String(createdById), nowMs, limit).map(mapMeeting);
  }

  setMemberAlias(guildId, { alias, userId, displayName, createdById }) {
    const normalized = normalizeMemberAlias(alias);
    const tenantId = String(guildId);
    const discordUserId = String(userId);
    const now = Date.now();
    return this.transaction(() => {
      const assigned = this.db.prepare(`
        SELECT * FROM member_aliases WHERE guild_id = ? AND alias_key = ?
      `).get(tenantId, normalized.aliasKey);
      if (assigned && assigned.user_id !== discordUserId) {
        throw new Error(`呼び名「${normalized.alias}」は別のメンバーに登録済みです`);
      }
      this.db.prepare(`
        INSERT INTO member_aliases(
          guild_id, alias_key, alias, user_id, display_name, created_by_id,
          created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, alias_key) DO UPDATE SET
          alias = excluded.alias,
          display_name = excluded.display_name,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        tenantId,
        normalized.aliasKey,
        normalized.alias,
        discordUserId,
        String(displayName).slice(0, 80),
        String(createdById),
        assigned ? Number(assigned.created_at_ms) : now,
        now,
      );
      return this.getMemberAlias(tenantId, normalized.alias);
    });
  }

  getMemberAlias(guildId, alias) {
    const { aliasKey } = normalizeMemberAlias(alias);
    return mapMemberAlias(this.db.prepare(`
      SELECT * FROM member_aliases WHERE guild_id = ? AND alias_key = ?
    `).get(String(guildId), aliasKey));
  }

  getMemberAliasByUserId(guildId, userId) {
    return mapMemberAlias(this.db.prepare(`
      SELECT * FROM member_aliases WHERE guild_id = ? AND user_id = ?
      ORDER BY updated_at_ms DESC, alias_key ASC
      LIMIT 1
    `).get(String(guildId), String(userId)));
  }

  listMemberAliases(guildId) {
    return this.db.prepare(`
      SELECT * FROM member_aliases WHERE guild_id = ? ORDER BY alias_key ASC
    `).all(String(guildId)).map(mapMemberAlias);
  }

  removeMemberAlias(guildId, alias) {
    const { aliasKey } = normalizeMemberAlias(alias);
    return this.db.prepare(`
      DELETE FROM member_aliases WHERE guild_id = ? AND alias_key = ?
    `).run(String(guildId), aliasKey).changes > 0;
  }

  resolveMemberAliases(guildId, aliases) {
    const found = [];
    const missing = [];
    for (const alias of aliases) {
      const member = this.getMemberAlias(guildId, alias);
      if (member) found.push(member);
      else missing.push(alias);
    }
    return { found, missing };
  }

  prepareMeetingInvitees(meetingId, invitees, invitedById, { defaultReminderMinutes = [] } = {}) {
    let meeting = this.getMeeting(meetingId);
    if (!meeting || meeting.status !== "active") throw new Error("招待できる会議が見つかりません");
    const prepared = [];
    const alreadySent = [];
    const seen = new Set();
    this.transaction(() => {
      meeting = this.getMeeting(meeting.id);
      if (!meeting || meeting.status !== "active") {
        throw Object.assign(new Error("Meeting is no longer active"), { code: "meeting_not_active" });
      }
      for (const invitee of invitees) {
        const userId = String(invitee.userId);
        if (seen.has(userId)) continue;
        seen.add(userId);
        const current = this.db.prepare(`
          SELECT * FROM meeting_invitees WHERE meeting_id = ? AND user_id = ?
        `).get(meeting.id, userId);
        if (current?.delivery_status === "sent") {
          alreadySent.push(mapInvitee(current));
          continue;
        }
        const now = Date.now();
        if (current) {
          this.db.prepare(`
            UPDATE meeting_invitees
            SET display_name = ?, invited_by_id = ?, delivery_status = 'pending',
                delivery_error_code = NULL, dm_message_id = NULL, delivered_at_ms = NULL
            WHERE meeting_id = ? AND user_id = ?
          `).run(String(invitee.displayName).slice(0, 80), String(invitedById), meeting.id, userId);
        } else {
          this.db.prepare(`
            INSERT INTO meeting_invitees(
              meeting_id, user_id, display_name, invited_by_id, delivery_status,
              delivery_error_code, dm_message_id, created_at_ms, delivered_at_ms
            ) VALUES(?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)
          `).run(meeting.id, userId, String(invitee.displayName).slice(0, 80), String(invitedById), now);
        }
        this.queueDirectInviteSendInternal(meeting.id, userId, meeting.updatedAtMs, now);
        prepared.push(this.getMeetingInvitee(meeting.id, userId));
      }
    });
    for (const invitee of [...prepared, ...alreadySent]) {
      if (this.personalReminders.getMeetingReminders(meeting.id, invitee.userId)) continue;
      this.personalReminders.copyPreferenceToMeeting({
        meetingId: meeting.id,
        guildId: meeting.guildId,
        userId: invitee.userId,
        startsAtMs: meeting.startsAtMs,
        fallbackMinutes: defaultReminderMinutes,
      });
    }
    return { prepared, alreadySent };
  }

  getMeetingInvitee(meetingId, userId) {
    return mapInvitee(this.db.prepare(`
      SELECT * FROM meeting_invitees WHERE meeting_id = ? AND user_id = ?
    `).get(String(meetingId).toUpperCase(), String(userId)));
  }

  listMeetingInvitees(meetingId) {
    return this.db.prepare(`
      SELECT * FROM meeting_invitees WHERE meeting_id = ? ORDER BY created_at_ms ASC
    `).all(String(meetingId).toUpperCase()).map(mapInvitee);
  }

  isMeetingInvitee(meetingId, userId) {
    return Boolean(this.getMeetingInvitee(meetingId, userId));
  }

  markInviteeDelivery(meetingId, userId, { status, dmMessageId = null, errorCode = null } = {}) {
    if (!["sent", "failed"].includes(status)) throw new Error("DM配信ステータスが正しくありません");
    const deliveredAtMs = status === "sent" ? Date.now() : null;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE meeting_invitees
        SET delivery_status = ?, delivery_error_code = ?, dm_message_id = ?, delivered_at_ms = ?
        WHERE meeting_id = ? AND user_id = ?
      `).run(
        status,
        errorCode ? String(errorCode).slice(0, 80) : null,
        dmMessageId ? String(dmMessageId) : null,
        deliveredAtMs,
        String(meetingId).toUpperCase(),
        String(userId),
      );
      this.db.prepare(`
        DELETE FROM direct_invite_sends WHERE meeting_id = ? AND user_id = ?
      `).run(String(meetingId).toUpperCase(), String(userId));
    });
  }

  queueDirectInviteSendInternal(meetingId, userId, targetUpdatedAtMs, nowMs) {
    return this.db.prepare(`
      INSERT INTO direct_invite_sends(
        meeting_id, user_id, target_updated_at_ms, status, attempts,
        next_attempt_at_ms, lease_expires_at_ms, claim_token, last_error_code,
        created_at_ms, updated_at_ms
      )
      SELECT i.meeting_id, i.user_id, ?, 'pending', 0, 0, NULL, NULL, NULL, ?, ?
      FROM meeting_invitees i
      JOIN meetings m ON m.id = i.meeting_id
      WHERE i.meeting_id = ? AND i.user_id = ? AND i.delivery_status = 'pending'
        AND m.updated_at_ms = ?
      ON CONFLICT(meeting_id, user_id) DO UPDATE SET
        target_updated_at_ms = excluded.target_updated_at_ms,
        status = 'pending', attempts = 0, next_attempt_at_ms = 0,
        lease_expires_at_ms = NULL, claim_token = NULL, last_error_code = NULL,
        updated_at_ms = excluded.updated_at_ms
      WHERE direct_invite_sends.target_updated_at_ms <> excluded.target_updated_at_ms
    `).run(
      Number(targetUpdatedAtMs),
      Number(nowMs),
      Number(nowMs),
      String(meetingId).toUpperCase(),
      String(userId),
      Number(targetUpdatedAtMs),
    ).changes;
  }

  retargetDirectInviteSendsInternal(meetingId, targetUpdatedAtMs, nowMs) {
    return this.db.prepare(`
      INSERT INTO direct_invite_sends(
        meeting_id, user_id, target_updated_at_ms, status, attempts,
        next_attempt_at_ms, lease_expires_at_ms, claim_token, last_error_code,
        created_at_ms, updated_at_ms
      )
      SELECT i.meeting_id, i.user_id, ?, 'pending', 0, 0, NULL, NULL, NULL, ?, ?
      FROM meeting_invitees i
      JOIN meetings m ON m.id = i.meeting_id
      WHERE i.meeting_id = ? AND i.delivery_status = 'pending'
        AND m.updated_at_ms = ?
      ON CONFLICT(meeting_id, user_id) DO UPDATE SET
        target_updated_at_ms = excluded.target_updated_at_ms,
        status = 'pending', attempts = 0, next_attempt_at_ms = 0,
        lease_expires_at_ms = NULL, claim_token = NULL, last_error_code = NULL,
        updated_at_ms = excluded.updated_at_ms
      WHERE direct_invite_sends.target_updated_at_ms <> excluded.target_updated_at_ms
    `).run(
      Number(targetUpdatedAtMs),
      Number(nowMs),
      Number(nowMs),
      String(meetingId).toUpperCase(),
      Number(targetUpdatedAtMs),
    ).changes;
  }

  claimDirectInviteSends({ nowMs = Date.now(), leaseMs = 120_000, limit = 25 } = {}) {
    const now = Number(nowMs);
    const lease = Math.max(1_000, Number(leaseMs));
    const batchLimit = Math.max(1, Math.min(100, Number(limit)));
    return this.transaction(() => {
      this.completeEndedMeetingsInternal(now);
      this.db.prepare(`
        UPDATE direct_invite_sends
        SET status = 'pending', lease_expires_at_ms = NULL, claim_token = NULL,
            updated_at_ms = ?
        WHERE status = 'sending' AND lease_expires_at_ms IS NOT NULL
          AND lease_expires_at_ms <= ?
      `).run(now, now);
      this.db.prepare(`
        UPDATE direct_invite_sends
        SET target_updated_at_ms = (
              SELECT m.updated_at_ms FROM meetings m WHERE m.id = direct_invite_sends.meeting_id
            ),
            status = 'pending', attempts = 0, next_attempt_at_ms = 0,
            lease_expires_at_ms = NULL, claim_token = NULL,
            last_error_code = 'target_superseded', updated_at_ms = ?
        WHERE EXISTS (
          SELECT 1 FROM meetings m
          WHERE m.id = direct_invite_sends.meeting_id
            AND m.updated_at_ms <> direct_invite_sends.target_updated_at_ms
        )
      `).run(now);
      this.db.prepare(`
        DELETE FROM direct_invite_sends
        WHERE NOT EXISTS (
          SELECT 1 FROM meeting_invitees i
          WHERE i.meeting_id = direct_invite_sends.meeting_id
            AND i.user_id = direct_invite_sends.user_id
            AND i.delivery_status = 'pending'
        )
      `).run();
      const rows = this.db.prepare(`
        SELECT o.meeting_id, o.user_id, o.target_updated_at_ms, o.attempts
        FROM direct_invite_sends o
        JOIN meetings m ON m.id = o.meeting_id
          AND m.updated_at_ms = o.target_updated_at_ms
        JOIN meeting_invitees i ON i.meeting_id = o.meeting_id AND i.user_id = o.user_id
        WHERE o.status = 'pending' AND o.next_attempt_at_ms <= ?
          AND i.delivery_status = 'pending'
        ORDER BY o.updated_at_ms ASC, o.meeting_id ASC, o.user_id ASC
        LIMIT ?
      `).all(now, batchLimit);
      const claimStatement = this.db.prepare(`
        UPDATE direct_invite_sends
        SET status = 'sending', attempts = attempts + 1,
            lease_expires_at_ms = ?, claim_token = ?, updated_at_ms = ?
        WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
          AND status = 'pending' AND next_attempt_at_ms <= ?
      `);
      const claims = [];
      for (const row of rows) {
        const claimToken = crypto.randomUUID();
        if (claimStatement.run(
          now + lease,
          claimToken,
          now,
          row.meeting_id,
          row.user_id,
          row.target_updated_at_ms,
          now,
        ).changes !== 1) continue;
        claims.push({
          meetingId: row.meeting_id,
          userId: row.user_id,
          targetUpdatedAtMs: Number(row.target_updated_at_ms),
          attempts: Number(row.attempts) + 1,
          claimToken,
        });
      }
      return claims;
    });
  }

  isDirectInviteSendClaimCurrent(claim) {
    if (!claim?.meetingId || !claim?.userId || !claim?.claimToken) return false;
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM direct_invite_sends o
      JOIN meetings m ON m.id = o.meeting_id
      JOIN meeting_invitees i ON i.meeting_id = o.meeting_id AND i.user_id = o.user_id
      WHERE o.meeting_id = ? AND o.user_id = ? AND o.target_updated_at_ms = ?
        AND o.status = 'sending' AND o.claim_token = ?
        AND m.updated_at_ms = o.target_updated_at_ms
        AND i.delivery_status = 'pending'
    `).get(
      String(claim.meetingId).toUpperCase(),
      String(claim.userId),
      Number(claim.targetUpdatedAtMs),
      String(claim.claimToken),
    ));
  }

  getDirectInviteSendData(claim) {
    if (!this.isDirectInviteSendClaimCurrent(claim)) return null;
    const meeting = this.getMeeting(claim.meetingId);
    const invitee = this.getMeetingInvitee(claim.meetingId, claim.userId);
    if (!meeting || meeting.updatedAtMs !== Number(claim.targetUpdatedAtMs)
      || !invitee || invitee.deliveryStatus !== "pending") return null;
    const reminder = this.personalReminders?.getMeetingReminders?.(meeting.id, invitee.userId);
    if (!this.isDirectInviteSendClaimCurrent(claim)) return null;
    return {
      meeting,
      invitee: {
        ...invitee,
        personalReminderMinutes: reminder?.minutes || [],
      },
    };
  }

  markDirectInviteSendSucceeded(claim, messageId, { sentAtMs = Date.now() } = {}) {
    if (!claim?.meetingId || !claim?.userId || !claim?.claimToken || !messageId) return false;
    return this.transaction(() => {
      if (!this.isDirectInviteSendClaimCurrent(claim)) return false;
      const meeting = this.getMeeting(claim.meetingId);
      if (!meeting || meeting.status !== "active") return false;
      const updated = this.db.prepare(`
        UPDATE meeting_invitees
        SET delivery_status = 'sent', delivery_error_code = NULL,
            dm_message_id = ?, delivered_at_ms = ?
        WHERE meeting_id = ? AND user_id = ? AND delivery_status = 'pending'
      `).run(
        String(messageId),
        Number(sentAtMs),
        String(claim.meetingId).toUpperCase(),
        String(claim.userId),
      );
      if (updated.changes !== 1) return false;
      const removed = this.db.prepare(`
        DELETE FROM direct_invite_sends
        WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
          AND status = 'sending' AND claim_token = ?
      `).run(
        String(claim.meetingId).toUpperCase(),
        String(claim.userId),
        Number(claim.targetUpdatedAtMs),
        String(claim.claimToken),
      );
      if (removed.changes !== 1) throw new Error("direct invite send receipt conflict");
      this.db.prepare(`
        DELETE FROM direct_invite_updates WHERE meeting_id = ? AND user_id = ?
      `).run(String(claim.meetingId).toUpperCase(), String(claim.userId));
      return true;
    });
  }

  markDirectInviteSendFailed(claim, {
    errorCode = "send_failed",
    retryable = true,
    maxAttempts = 5,
    failedAtMs = Date.now(),
  } = {}) {
    if (!claim?.meetingId || !claim?.userId || !claim?.claimToken) return false;
    const row = this.db.prepare(`
      SELECT attempts FROM direct_invite_sends
      WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
        AND status = 'sending' AND claim_token = ?
    `).get(
      String(claim.meetingId).toUpperCase(),
      String(claim.userId),
      Number(claim.targetUpdatedAtMs),
      String(claim.claimToken),
    );
    if (!row || !this.isDirectInviteSendClaimCurrent(claim)) return false;
    const attempts = Number(row.attempts || 1);
    const now = Number(failedAtMs);
    const shouldRetry = Boolean(retryable) && attempts < Math.max(0, Number(maxAttempts));
    if (shouldRetry) {
      const delayMs = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(attempts - 1, 6)));
      return this.db.prepare(`
        UPDATE direct_invite_sends
        SET status = 'pending', next_attempt_at_ms = ?, lease_expires_at_ms = NULL,
            claim_token = NULL, last_error_code = ?, updated_at_ms = ?
        WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
          AND status = 'sending' AND claim_token = ?
      `).run(
        now + delayMs,
        String(errorCode).slice(0, 80),
        now,
        String(claim.meetingId).toUpperCase(),
        String(claim.userId),
        Number(claim.targetUpdatedAtMs),
        String(claim.claimToken),
      ).changes === 1;
    }
    return this.transaction(() => {
      if (!this.isDirectInviteSendClaimCurrent(claim)) return false;
      this.db.prepare(`
        UPDATE meeting_invitees
        SET delivery_status = 'failed', delivery_error_code = ?,
            dm_message_id = NULL, delivered_at_ms = NULL
        WHERE meeting_id = ? AND user_id = ? AND delivery_status = 'pending'
      `).run(
        String(errorCode).slice(0, 80),
        String(claim.meetingId).toUpperCase(),
        String(claim.userId),
      );
      return this.db.prepare(`
        DELETE FROM direct_invite_sends
        WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
          AND status = 'sending' AND claim_token = ?
      `).run(
        String(claim.meetingId).toUpperCase(),
        String(claim.userId),
        Number(claim.targetUpdatedAtMs),
        String(claim.claimToken),
      ).changes === 1;
    });
  }

  closeDirectInviteSendForInactive(claim, { errorCode = "meeting_not_active" } = {}) {
    if (!claim?.meetingId || !claim?.userId || !claim?.claimToken) return false;
    return this.transaction(() => {
      if (!this.isDirectInviteSendClaimCurrent(claim)) return false;
      const meeting = this.getMeeting(claim.meetingId);
      if (!meeting || meeting.status === "active") return false;
      this.db.prepare(`
        UPDATE meeting_invitees
        SET delivery_status = 'failed', delivery_error_code = ?,
            dm_message_id = NULL, delivered_at_ms = NULL
        WHERE meeting_id = ? AND user_id = ? AND delivery_status = 'pending'
      `).run(
        String(errorCode).slice(0, 80),
        String(claim.meetingId).toUpperCase(),
        String(claim.userId),
      );
      return this.db.prepare(`
        DELETE FROM direct_invite_sends
        WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
          AND status = 'sending' AND claim_token = ?
      `).run(
        String(claim.meetingId).toUpperCase(),
        String(claim.userId),
        Number(claim.targetUpdatedAtMs),
        String(claim.claimToken),
      ).changes === 1;
    });
  }

  reconcileDirectInviteSendStaleReceipt(claim, messageId, { nowMs = Date.now() } = {}) {
    if (!claim?.meetingId || !claim?.userId || !messageId) return "delete";
    return this.transaction(() => {
      const meeting = this.getMeeting(claim.meetingId);
      const invitee = this.getMeetingInvitee(claim.meetingId, claim.userId);
      if (meeting && invitee?.deliveryStatus === "sent") {
        if (invitee.dmMessageId === String(messageId)) {
          this.queueDirectInviteUpdateForRecipientInternal(
            meeting.id,
            invitee.userId,
            meeting.updatedAtMs,
            Number(nowMs),
          );
          return "repair_current";
        }
        return "delete";
      }
      if (meeting && invitee?.deliveryStatus === "pending") {
        this.retargetDirectInviteSendsInternal(meeting.id, meeting.updatedAtMs, Number(nowMs));
        // Leave the visible message for the next-generation job.  Its recent-DM
        // scan will update and adopt it, avoiding a delete/adopt race and resend.
        return "keep_for_recovery";
      }
      return "delete";
    });
  }

  getDirectInviteSendSummary(meetingId, targetUpdatedAtMs = null) {
    const meeting = this.getMeeting(meetingId);
    const target = targetUpdatedAtMs == null ? meeting?.updatedAtMs : Number(targetUpdatedAtMs);
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count, MAX(next_attempt_at_ms) AS next_attempt_at_ms
      FROM direct_invite_sends
      WHERE meeting_id = ? AND target_updated_at_ms = ?
      GROUP BY status
    `).all(String(meetingId).toUpperCase(), target);
    const summary = { pending: 0, sending: 0, unresolved: 0, nextAttemptAtMs: 0 };
    for (const row of rows) {
      summary[row.status] = Number(row.count);
      summary.nextAttemptAtMs = Math.max(summary.nextAttemptAtMs, Number(row.next_attempt_at_ms || 0));
    }
    summary.unresolved = summary.pending + summary.sending;
    return summary;
  }

  queueMeetingCardUpdateInternal(meetingId, targetCardRevision, nowMs) {
    return this.db.prepare(`
      INSERT INTO meeting_card_updates(
        meeting_id, target_card_revision, status, attempts, next_attempt_at_ms,
        lease_expires_at_ms, claim_token, last_error_code, created_at_ms, updated_at_ms
      )
      SELECT id, ?, 'pending', 0, 0, NULL, NULL, NULL, ?, ?
      FROM meetings
      WHERE id = ? AND message_id IS NOT NULL AND card_revision = ?
      ON CONFLICT(meeting_id) DO UPDATE SET
        target_card_revision = excluded.target_card_revision,
        status = 'pending', attempts = 0, next_attempt_at_ms = 0,
        lease_expires_at_ms = NULL, claim_token = NULL, last_error_code = NULL,
        updated_at_ms = excluded.updated_at_ms
      WHERE meeting_card_updates.target_card_revision <> excluded.target_card_revision
    `).run(
      Number(targetCardRevision),
      Number(nowMs),
      Number(nowMs),
      String(meetingId).toUpperCase(),
      Number(targetCardRevision),
    ).changes;
  }

  queueMeetingCardUpdate(meetingId, { targetCardRevision = null, nowMs = Date.now() } = {}) {
    const meeting = this.getMeeting(meetingId);
    if (!meeting) throw new Error("会議が見つかりません");
    const target = targetCardRevision == null ? meeting.cardRevision : Number(targetCardRevision);
    if (!Number.isSafeInteger(target) || target !== meeting.cardRevision) throw updateConflict();
    const now = Number(nowMs);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("現在日時が正しくありません");
    return this.queueMeetingCardUpdateInternal(meeting.id, target, now);
  }

  acknowledgePendingMeetingCardUpdate(meetingId, targetCardRevision) {
    return this.db.prepare(`
      DELETE FROM meeting_card_updates
      WHERE meeting_id = ? AND target_card_revision = ? AND status = 'pending'
    `).run(
      String(meetingId).toUpperCase(),
      Number(targetCardRevision),
    ).changes === 1;
  }

  claimMeetingCardUpdates({ nowMs = Date.now(), leaseMs = 120_000, limit = 25 } = {}) {
    const now = Number(nowMs);
    const lease = Math.max(1_000, Number(leaseMs));
    const batchLimit = Math.max(1, Math.min(100, Number(limit)));
    return this.transaction(() => {
      this.db.prepare("DELETE FROM direct_invite_updates WHERE status = 'skipped'").run();
      this.db.prepare(`
        UPDATE meeting_card_updates
        SET status = 'pending', lease_expires_at_ms = NULL, claim_token = NULL, updated_at_ms = ?
        WHERE status = 'sending' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
      `).run(now, now);
      this.db.prepare(`
        UPDATE meeting_card_updates
        SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
            last_error_code = 'target_superseded', updated_at_ms = ?
        WHERE status IN ('pending', 'sending')
          AND NOT EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = meeting_card_updates.meeting_id
              AND m.card_revision = meeting_card_updates.target_card_revision
              AND m.message_id IS NOT NULL
          )
      `).run(now);
      const rows = this.db.prepare(`
        SELECT meeting_id, target_card_revision, attempts
        FROM meeting_card_updates
        WHERE status = 'pending' AND next_attempt_at_ms <= ?
        ORDER BY updated_at_ms ASC, meeting_id ASC
        LIMIT ?
      `).all(now, batchLimit);
      const statement = this.db.prepare(`
        UPDATE meeting_card_updates
        SET status = 'sending', attempts = attempts + 1,
            lease_expires_at_ms = ?, claim_token = ?, updated_at_ms = ?
        WHERE meeting_id = ? AND target_card_revision = ?
          AND status = 'pending' AND next_attempt_at_ms <= ?
      `);
      const claims = [];
      for (const row of rows) {
        const claimToken = crypto.randomUUID();
        const result = statement.run(
          now + lease,
          claimToken,
          now,
          row.meeting_id,
          row.target_card_revision,
          now,
        );
        if (result.changes !== 1) continue;
        claims.push({
          meetingId: row.meeting_id,
          targetCardRevision: Number(row.target_card_revision),
          attempts: Number(row.attempts) + 1,
          claimToken,
        });
      }
      return claims;
    });
  }

  isMeetingCardUpdateClaimCurrent(claim) {
    if (!claim?.meetingId || !claim?.claimToken) return false;
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM meeting_card_updates o
      JOIN meetings m ON m.id = o.meeting_id
      WHERE o.meeting_id = ? AND o.target_card_revision = ?
        AND o.status = 'sending' AND o.claim_token = ?
        AND m.card_revision = o.target_card_revision AND m.message_id IS NOT NULL
    `).get(
      String(claim.meetingId).toUpperCase(),
      Number(claim.targetCardRevision),
      String(claim.claimToken),
    ));
  }

  getMeetingCardUpdateData(claim) {
    if (!this.isMeetingCardUpdateClaimCurrent(claim)) return null;
    const meeting = this.getMeeting(claim.meetingId);
    if (!meeting) return null;
    return {
      meeting,
      rsvps: this.listRsvps(meeting.id),
      invitees: this.listMeetingInvitees(meeting.id),
    };
  }

  markMeetingCardUpdateSucceeded(claim) {
    if (!claim?.meetingId || !claim?.claimToken) return false;
    return this.db.prepare(`
      DELETE FROM meeting_card_updates
      WHERE meeting_id = ? AND target_card_revision = ?
        AND status = 'sending' AND claim_token = ?
        AND EXISTS (
          SELECT 1 FROM meetings m
          WHERE m.id = meeting_card_updates.meeting_id
            AND m.card_revision = meeting_card_updates.target_card_revision
            AND m.message_id IS NOT NULL
        )
    `).run(
      String(claim.meetingId).toUpperCase(),
      Number(claim.targetCardRevision),
      String(claim.claimToken),
    ).changes === 1;
  }

  adoptRecreatedMeetingCard(claim, { expectedMessageId, newMessageId } = {}) {
    if (!claim?.meetingId || !claim?.claimToken || !expectedMessageId || !newMessageId) return false;
    return this.transaction(() => {
      const adopted = this.db.prepare(`
        UPDATE meetings
        SET message_id = ?
        WHERE id = ? AND message_id = ? AND card_revision = ?
          AND EXISTS (
            SELECT 1 FROM meeting_card_updates o
            WHERE o.meeting_id = meetings.id
              AND o.target_card_revision = ?
              AND o.status = 'sending' AND o.claim_token = ?
          )
      `).run(
        String(newMessageId),
        String(claim.meetingId).toUpperCase(),
        String(expectedMessageId),
        Number(claim.targetCardRevision),
        Number(claim.targetCardRevision),
        String(claim.claimToken),
      );
      if (adopted.changes !== 1) return false;
      const receipt = this.db.prepare(`
        DELETE FROM meeting_card_updates
        WHERE meeting_id = ? AND target_card_revision = ?
          AND status = 'sending' AND claim_token = ?
      `).run(
        String(claim.meetingId).toUpperCase(),
        Number(claim.targetCardRevision),
        String(claim.claimToken),
      );
      if (receipt.changes !== 1) {
        throw Object.assign(new Error("Meeting card recreation receipt was not saved"), {
          code: "card_recreation_receipt_failed",
        });
      }
      return true;
    });
  }

  markMeetingCardUpdateFailed(claim, {
    errorCode = "card_update_failed",
    retryable = true,
    maxAttempts = 5,
    failedAtMs = Date.now(),
  } = {}) {
    if (!claim?.meetingId || !claim?.claimToken) return false;
    const row = this.db.prepare(`
      SELECT attempts FROM meeting_card_updates
      WHERE meeting_id = ? AND target_card_revision = ?
        AND status = 'sending' AND claim_token = ?
    `).get(
      String(claim.meetingId).toUpperCase(),
      Number(claim.targetCardRevision),
      String(claim.claimToken),
    );
    if (!row || !this.isMeetingCardUpdateClaimCurrent(claim)) return false;
    const attempts = Number(row.attempts || 1);
    const now = Number(failedAtMs);
    const shouldRetry = Boolean(retryable) && attempts < Math.max(0, Number(maxAttempts));
    const delayMs = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(attempts - 1, 6)));
    return this.db.prepare(`
      UPDATE meeting_card_updates
      SET status = ?, next_attempt_at_ms = ?, lease_expires_at_ms = NULL,
          claim_token = NULL, last_error_code = ?, updated_at_ms = ?
      WHERE meeting_id = ? AND target_card_revision = ?
        AND status = 'sending' AND claim_token = ?
    `).run(
      shouldRetry ? "pending" : "skipped",
      shouldRetry ? now + delayMs : 0,
      String(errorCode).slice(0, 80),
      now,
      String(claim.meetingId).toUpperCase(),
      Number(claim.targetCardRevision),
      String(claim.claimToken),
    ).changes === 1;
  }

  getMeetingCardUpdateSummary(meetingId, targetCardRevision = null) {
    const meeting = this.getMeeting(meetingId);
    const target = targetCardRevision == null ? meeting?.cardRevision : Number(targetCardRevision);
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count, MAX(next_attempt_at_ms) AS next_attempt_at_ms
      FROM meeting_card_updates
      WHERE meeting_id = ? AND target_card_revision = ?
      GROUP BY status
    `).all(String(meetingId).toUpperCase(), target);
    const summary = { pending: 0, sending: 0, skipped: 0, unresolved: 0, nextAttemptAtMs: 0 };
    for (const row of rows) {
      summary[row.status] = Number(row.count);
      summary.nextAttemptAtMs = Math.max(summary.nextAttemptAtMs, Number(row.next_attempt_at_ms || 0));
    }
    summary.unresolved = summary.pending + summary.sending + summary.skipped;
    return summary;
  }

  invalidateSendingDeliveryClaimsInternal(meetingId, nowMs, reason = "content_superseded") {
    return this.db.prepare(`
      UPDATE deliveries
      SET status = 'pending', next_attempt_at_ms = 0,
          lease_expires_at_ms = NULL, claim_token = NULL,
          last_error_code = ?
      WHERE meeting_id = ? AND status = 'sending'
    `).run(
      String(reason).slice(0, 80),
      String(meetingId).toUpperCase(),
    ).changes;
  }

  queueDirectInviteUpdatesInternal(meetingId, targetUpdatedAtMs, nowMs) {
    return this.db.prepare(`
      INSERT INTO direct_invite_updates(
        meeting_id, user_id, target_updated_at_ms, status, attempts,
        next_attempt_at_ms, lease_expires_at_ms, claim_token, last_error_code,
        created_at_ms, updated_at_ms
      )
      SELECT meeting_id, user_id, ?, 'pending', 0, 0, NULL, NULL, NULL, ?, ?
      FROM meeting_invitees
      WHERE meeting_id = ? AND delivery_status = 'sent' AND dm_message_id IS NOT NULL
      ON CONFLICT(meeting_id, user_id) DO UPDATE SET
        target_updated_at_ms = excluded.target_updated_at_ms,
        status = 'pending', attempts = 0, next_attempt_at_ms = 0,
        lease_expires_at_ms = NULL, claim_token = NULL, last_error_code = NULL,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      Number(targetUpdatedAtMs),
      Number(nowMs),
      Number(nowMs),
      String(meetingId).toUpperCase(),
    ).changes;
  }

  queueDirectInviteUpdateForRecipientInternal(meetingId, userId, targetUpdatedAtMs, nowMs) {
    return this.db.prepare(`
      INSERT INTO direct_invite_updates(
        meeting_id, user_id, target_updated_at_ms, status, attempts,
        next_attempt_at_ms, lease_expires_at_ms, claim_token, last_error_code,
        created_at_ms, updated_at_ms
      )
      SELECT i.meeting_id, i.user_id, ?, 'pending', 0, 0, NULL, NULL, NULL, ?, ?
      FROM meeting_invitees i
      JOIN meetings m ON m.id = i.meeting_id
      WHERE i.meeting_id = ? AND i.user_id = ?
        AND i.delivery_status = 'sent' AND i.dm_message_id IS NOT NULL
        AND m.updated_at_ms = ?
      ON CONFLICT(meeting_id, user_id) DO UPDATE SET
        target_updated_at_ms = excluded.target_updated_at_ms,
        status = 'pending', attempts = 0, next_attempt_at_ms = 0,
        lease_expires_at_ms = NULL, claim_token = NULL, last_error_code = NULL,
        updated_at_ms = excluded.updated_at_ms
      WHERE direct_invite_updates.target_updated_at_ms <> excluded.target_updated_at_ms
    `).run(
      Number(targetUpdatedAtMs),
      Number(nowMs),
      Number(nowMs),
      String(meetingId).toUpperCase(),
      String(userId),
      Number(targetUpdatedAtMs),
    ).changes;
  }

  queueDirectInviteUpdates(meetingId, { targetUpdatedAtMs = null, nowMs = Date.now() } = {}) {
    const meeting = this.getMeeting(meetingId);
    if (!meeting) throw new Error("会議が見つかりません");
    const target = targetUpdatedAtMs == null ? meeting.updatedAtMs : Number(targetUpdatedAtMs);
    if (!Number.isSafeInteger(target) || target !== meeting.updatedAtMs) {
      throw updateConflict();
    }
    const now = Number(nowMs);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("現在日時が正しくありません");
    return this.queueDirectInviteUpdatesInternal(meeting.id, target, now);
  }

  claimDirectInviteUpdates({ nowMs = Date.now(), leaseMs = 120_000, limit = 25 } = {}) {
    const now = Number(nowMs);
    const lease = Math.max(1_000, Number(leaseMs));
    const batchLimit = Math.max(1, Math.min(100, Number(limit)));
    return this.transaction(() => {
      this.db.prepare(`
        UPDATE direct_invite_updates
        SET status = 'pending', lease_expires_at_ms = NULL, claim_token = NULL,
            updated_at_ms = ?
        WHERE status = 'sending' AND lease_expires_at_ms IS NOT NULL
          AND lease_expires_at_ms <= ?
      `).run(now, now);
      this.db.prepare(`
        DELETE FROM direct_invite_updates
        WHERE status IN ('pending', 'sending')
          AND NOT EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = direct_invite_updates.meeting_id
              AND m.updated_at_ms = direct_invite_updates.target_updated_at_ms
          )
      `).run();
      const rows = this.db.prepare(`
        SELECT o.meeting_id, o.user_id, o.target_updated_at_ms, o.attempts,
               i.display_name, i.dm_message_id
        FROM direct_invite_updates o
        JOIN meetings m ON m.id = o.meeting_id
          AND m.updated_at_ms = o.target_updated_at_ms
        JOIN meeting_invitees i ON i.meeting_id = o.meeting_id AND i.user_id = o.user_id
        WHERE o.status = 'pending' AND o.next_attempt_at_ms <= ?
          AND i.delivery_status = 'sent' AND i.dm_message_id IS NOT NULL
        ORDER BY o.updated_at_ms ASC, o.meeting_id ASC, o.user_id ASC
        LIMIT ?
      `).all(now, batchLimit);
      const claimed = [];
      const claimStatement = this.db.prepare(`
        UPDATE direct_invite_updates
        SET status = 'sending', attempts = attempts + 1,
            lease_expires_at_ms = ?, claim_token = ?, updated_at_ms = ?
        WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
          AND status = 'pending' AND next_attempt_at_ms <= ?
      `);
      for (const row of rows) {
        const claimToken = crypto.randomUUID();
        const result = claimStatement.run(
          now + lease,
          claimToken,
          now,
          row.meeting_id,
          row.user_id,
          row.target_updated_at_ms,
          now,
        );
        if (result.changes !== 1) continue;
        claimed.push({
          meetingId: row.meeting_id,
          userId: row.user_id,
          targetUpdatedAtMs: Number(row.target_updated_at_ms),
          displayName: row.display_name,
          dmMessageId: row.dm_message_id,
          attempts: Number(row.attempts) + 1,
          claimToken,
          meeting: this.getMeeting(row.meeting_id),
        });
      }
      return claimed;
    });
  }

  isDirectInviteUpdateClaimCurrent(claim) {
    if (!claim?.meetingId || !claim?.userId || !claim?.claimToken) return false;
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM direct_invite_updates o
      JOIN meetings m ON m.id = o.meeting_id
      WHERE o.meeting_id = ? AND o.user_id = ? AND o.target_updated_at_ms = ?
        AND o.status = 'sending' AND o.claim_token = ?
        AND m.updated_at_ms = o.target_updated_at_ms
    `).get(
      String(claim.meetingId).toUpperCase(),
      String(claim.userId),
      Number(claim.targetUpdatedAtMs),
      String(claim.claimToken),
    ));
  }

  markDirectInviteUpdateSucceeded(claim) {
    if (!claim?.meetingId || !claim?.userId || !claim?.claimToken) return false;
    return this.transaction(() => {
      const removed = this.db.prepare(`
        DELETE FROM direct_invite_updates
        WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
          AND status = 'sending' AND claim_token = ?
          AND EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = direct_invite_updates.meeting_id
              AND m.updated_at_ms = direct_invite_updates.target_updated_at_ms
          )
      `).run(
        String(claim.meetingId).toUpperCase(),
        String(claim.userId),
        Number(claim.targetUpdatedAtMs),
        String(claim.claimToken),
      );
      if (removed.changes === 1) return true;

      // The Discord edit may have completed after a newer generation was
      // already acknowledged and removed.  Re-enqueue the current generation
      // so the late old edit is deterministically repaired on the next tick.
      const current = this.getMeeting(claim.meetingId);
      if (current) {
        this.queueDirectInviteUpdateForRecipientInternal(
          current.id,
          claim.userId,
          current.updatedAtMs,
          Date.now(),
        );
      }
      return false;
    });
  }

  markDirectInviteUpdateFailed(claim, {
    errorCode = "update_failed",
    retryable = true,
    maxAttempts = 5,
    failedAtMs = Date.now(),
  } = {}) {
    if (!claim?.meetingId || !claim?.userId || !claim?.claimToken) return false;
    const row = this.db.prepare(`
      SELECT attempts FROM direct_invite_updates
      WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
        AND status = 'sending' AND claim_token = ?
    `).get(
      String(claim.meetingId).toUpperCase(),
      String(claim.userId),
      Number(claim.targetUpdatedAtMs),
      String(claim.claimToken),
    );
    if (!row || !this.isDirectInviteUpdateClaimCurrent(claim)) return false;
    const attempts = Number(row.attempts || 1);
    const now = Number(failedAtMs);
    const shouldRetry = Boolean(retryable) && attempts < Math.max(0, Number(maxAttempts));
    const delayMs = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(attempts - 1, 6)));
    if (!shouldRetry) {
      return this.db.prepare(`
        DELETE FROM direct_invite_updates
        WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
          AND status = 'sending' AND claim_token = ?
      `).run(
        String(claim.meetingId).toUpperCase(),
        String(claim.userId),
        Number(claim.targetUpdatedAtMs),
        String(claim.claimToken),
      ).changes === 1;
    }
    return this.db.prepare(`
      UPDATE direct_invite_updates
      SET status = ?, next_attempt_at_ms = ?, lease_expires_at_ms = NULL,
          claim_token = NULL, last_error_code = ?, updated_at_ms = ?
      WHERE meeting_id = ? AND user_id = ? AND target_updated_at_ms = ?
        AND status = 'sending' AND claim_token = ?
    `).run(
      "pending",
      now + delayMs,
      String(errorCode).slice(0, 80),
      now,
      String(claim.meetingId).toUpperCase(),
      String(claim.userId),
      Number(claim.targetUpdatedAtMs),
      String(claim.claimToken),
    ).changes === 1;
  }

  getDirectInviteUpdateSummary(meetingId, targetUpdatedAtMs = null) {
    const meeting = this.getMeeting(meetingId);
    const target = targetUpdatedAtMs == null ? meeting?.updatedAtMs : Number(targetUpdatedAtMs);
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count, MAX(next_attempt_at_ms) AS next_attempt_at_ms
      FROM direct_invite_updates
      WHERE meeting_id = ? AND target_updated_at_ms = ?
      GROUP BY status
    `).all(String(meetingId).toUpperCase(), target);
    const summary = { pending: 0, sending: 0, skipped: 0, unresolved: 0, nextAttemptAtMs: 0 };
    for (const row of rows) {
      summary[row.status] = Number(row.count);
      summary.nextAttemptAtMs = Math.max(summary.nextAttemptAtMs, Number(row.next_attempt_at_ms || 0));
    }
    summary.unresolved = summary.pending + summary.sending + summary.skipped;
    return summary;
  }

  listOpenInvitationsForUser(userId, { nowMs = Date.now(), limit = 20 } = {}) {
    return this.db.prepare(`
      SELECT m.*, i.delivery_status, i.delivery_error_code, i.dm_message_id,
             i.display_name AS invitee_display_name, i.created_at_ms AS invitee_created_at_ms,
             i.delivered_at_ms
      FROM meeting_invitees i
      JOIN meetings m ON m.id = i.meeting_id
      WHERE i.user_id = ? AND m.status = 'active' AND m.ends_at_ms >= ?
      ORDER BY m.starts_at_ms ASC LIMIT ?
    `).all(String(userId), nowMs, limit).map((row) => ({
      ...mapMeeting(row),
      invitation: {
        deliveryStatus: row.delivery_status,
        deliveryErrorCode: row.delivery_error_code || null,
        dmMessageId: row.dm_message_id || null,
        displayName: row.invitee_display_name,
        createdAtMs: Number(row.invitee_created_at_ms),
        deliveredAtMs: row.delivered_at_ms == null ? null : Number(row.delivered_at_ms),
      },
    }));
  }

  upsertRsvp(meetingId, { userId, displayName, status }) {
    if (!RSVP_STATUSES.has(status)) throw new Error("出欠ステータスが正しくありません");
    this.completeEndedMeetings();
    const meeting = this.getMeeting(meetingId);
    if (!meeting || meeting.status !== "active") throw new Error("回答できる会議が見つかりません");
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO rsvps(meeting_id, user_id, display_name, status, updated_at_ms)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(meeting_id, user_id) DO UPDATE SET
          display_name = excluded.display_name,
          status = excluded.status,
          updated_at_ms = excluded.updated_at_ms
      `).run(meeting.id, String(userId), displayName, status, now);
      const update = this.db.prepare(`
        UPDATE meetings SET card_revision = card_revision + 1
        WHERE id = ? AND status = 'active' AND card_revision = ?
      `).run(meeting.id, meeting.cardRevision);
      if (update.changes !== 1) throw updateConflict();
      this.queueMeetingCardUpdateInternal(meeting.id, meeting.cardRevision + 1, now);
    });
    return this.listRsvps(meeting.id);
  }

  listRsvps(meetingId) {
    return this.db.prepare("SELECT * FROM rsvps WHERE meeting_id = ? ORDER BY updated_at_ms ASC")
      .all(String(meetingId).toUpperCase()).map(mapRsvp);
  }

  claimDueDeliveries({ nowMs = Date.now(), maxLateMinutes = 10, leaseMs = 120_000, limit = 10 } = {}) {
    return this.transaction(() => {
      this.completeEndedMeetingsInternal(Number(nowMs));
      this.db.prepare(`
        UPDATE deliveries
        SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
            last_error_code = 'schedule_superseded'
        WHERE status IN ('pending', 'sending')
          AND EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = deliveries.meeting_id
              AND (m.status != 'active' OR m.schedule_revision != deliveries.schedule_revision)
          )
      `).run();
      this.db.prepare(`
        UPDATE deliveries
        SET status = 'pending', lease_expires_at_ms = NULL, claim_token = NULL
        WHERE status = 'sending' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
      `).run(nowMs);
      const oldestAllowed = nowMs - maxLateMinutes * 60_000;
      this.db.prepare(`
        UPDATE deliveries SET status = 'skipped', last_error_code = 'too_late'
        WHERE status = 'pending' AND due_at_ms < ?
      `).run(oldestAllowed);
      const rows = this.db.prepare(`
        SELECT d.*, m.guild_id, m.channel_id, m.title, m.starts_at_ms, m.ends_at_ms,
               m.meeting_url, m.status AS meeting_status
        FROM deliveries d
        JOIN meetings m ON m.id = d.meeting_id
        WHERE d.status = 'pending'
          AND d.due_at_ms <= ?
          AND d.due_at_ms >= ?
          AND d.next_attempt_at_ms <= ?
          AND m.status = 'active'
          AND d.schedule_revision = m.schedule_revision
        ORDER BY d.due_at_ms ASC
        LIMIT ?
      `).all(nowMs, oldestAllowed, nowMs, limit);
      const claim = this.db.prepare(`
        UPDATE deliveries
        SET status = 'sending', attempts = attempts + 1, lease_expires_at_ms = ?, claim_token = ?
        WHERE meeting_id = ? AND schedule_revision = ? AND offset_minutes = ?
          AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = deliveries.meeting_id AND m.status = 'active'
              AND m.schedule_revision = deliveries.schedule_revision
          )
      `);
      const claimed = [];
      for (const row of rows) {
        const claimToken = crypto.randomUUID();
        if (claim.run(
          nowMs + leaseMs,
          claimToken,
          row.meeting_id,
          row.schedule_revision,
          row.offset_minutes,
        ).changes === 1) {
          claimed.push({
            ...mapDelivery({
              ...row,
              status: "sending",
              attempts: Number(row.attempts) + 1,
              claim_token: claimToken,
            }),
            guildId: row.guild_id,
            channelId: row.channel_id,
            title: row.title,
            startsAtMs: Number(row.starts_at_ms),
            endsAtMs: Number(row.ends_at_ms),
            meetingUrl: row.meeting_url,
          });
        }
      }
      return claimed;
    });
  }

  isDeliveryClaimCurrent(delivery) {
    if (!delivery?.meetingId || delivery.scheduleRevision == null || !delivery.claimToken) return false;
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM deliveries d
      JOIN meetings m ON m.id = d.meeting_id
      WHERE d.meeting_id = ? AND d.schedule_revision = ? AND d.offset_minutes = ?
        AND d.status = 'sending' AND d.claim_token = ?
        AND m.status = 'active' AND m.schedule_revision = d.schedule_revision
      LIMIT 1
    `).get(
      String(delivery.meetingId).toUpperCase(),
      Number(delivery.scheduleRevision),
      Number(delivery.offsetMinutes),
      String(delivery.claimToken),
    ));
  }

  markDeliverySent(meetingId, offsetMinutes, {
    discordMessageId,
    sentAtMs = Date.now(),
    scheduleRevision = null,
    claimToken = null,
  }) {
    const revision = scheduleRevision ?? this.getMeeting(meetingId)?.scheduleRevision;
    if (revision == null) return false;
    const result = this.db.prepare(`
      UPDATE deliveries
      SET status = 'sent', discord_message_id = ?, sent_at_ms = ?,
          lease_expires_at_ms = NULL, claim_token = NULL, last_error_code = NULL
      WHERE meeting_id = ? AND schedule_revision = ? AND offset_minutes = ?
        AND status = 'sending' AND (? IS NULL OR claim_token = ?)
    `).run(
      String(discordMessageId),
      sentAtMs,
      meetingId,
      revision,
      offsetMinutes,
      claimToken,
      claimToken,
    );
    return result.changes === 1;
  }

  markDeliveryFailed(meetingId, offsetMinutes, {
    errorCode = "send_failed",
    nowMs = Date.now(),
    scheduleRevision = null,
    claimToken = null,
  } = {}) {
    const revision = scheduleRevision ?? this.getMeeting(meetingId)?.scheduleRevision;
    if (revision == null) return false;
    const row = this.db.prepare(`
      SELECT attempts FROM deliveries
      WHERE meeting_id = ? AND schedule_revision = ? AND offset_minutes = ?
        AND status = 'sending' AND (? IS NULL OR claim_token = ?)
    `).get(meetingId, revision, offsetMinutes, claimToken, claimToken);
    if (!row) return false;
    const attempts = Number(row?.attempts || 1);
    const delayMs = Math.min(15 * 60_000, 15_000 * (2 ** Math.min(attempts - 1, 6)));
    const result = this.db.prepare(`
      UPDATE deliveries
      SET status = 'pending', next_attempt_at_ms = ?, lease_expires_at_ms = NULL,
          claim_token = NULL, last_error_code = ?
      WHERE meeting_id = ? AND schedule_revision = ? AND offset_minutes = ?
        AND status = 'sending' AND (? IS NULL OR claim_token = ?)
    `).run(
      nowMs + delayMs,
      String(errorCode).slice(0, 80),
      meetingId,
      revision,
      offsetMinutes,
      claimToken,
      claimToken,
    );
    return result.changes === 1;
  }

  markDeliveryUncertain(meetingId, offsetMinutes, {
    errorCode = "receipt_persist_failed",
    discordMessageId = null,
    nowMs = Date.now(),
    scheduleRevision = null,
    claimToken = null,
  } = {}) {
    const revision = scheduleRevision ?? this.getMeeting(meetingId)?.scheduleRevision;
    if (revision == null) return false;
    return this.db.prepare(`
      UPDATE deliveries
      SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
          discord_message_id = COALESCE(?, discord_message_id),
          sent_at_ms = COALESCE(sent_at_ms, ?), last_error_code = ?
      WHERE meeting_id = ? AND schedule_revision = ? AND offset_minutes = ?
        AND status = 'sending' AND (? IS NULL OR claim_token = ?)
    `).run(
      discordMessageId == null ? null : String(discordMessageId),
      Number(nowMs),
      String(errorCode).slice(0, 80),
      meetingId,
      revision,
      offsetMinutes,
      claimToken,
      claimToken,
    ).changes === 1;
  }

  getSnapshot() {
    return {
      meetings: this.db.prepare("SELECT * FROM meetings ORDER BY starts_at_ms ASC").all().map(mapMeeting),
      rsvps: this.db.prepare("SELECT * FROM rsvps ORDER BY meeting_id, updated_at_ms ASC").all().map(mapRsvp),
      invitees: this.db.prepare("SELECT * FROM meeting_invitees ORDER BY meeting_id, created_at_ms ASC").all().map(mapInvitee),
      memberAliases: this.db.prepare("SELECT * FROM member_aliases ORDER BY guild_id, alias_key ASC").all().map(mapMemberAlias),
      deliveries: this.db.prepare("SELECT * FROM deliveries ORDER BY due_at_ms ASC").all().map(mapDelivery),
    };
  }

  close() {
    this.db.close();
  }
}
