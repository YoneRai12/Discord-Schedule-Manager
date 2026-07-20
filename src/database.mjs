import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeMemberAlias } from "./participants.mjs";
import { generateMeetingId, normalizeMeetingId } from "./meeting-id.mjs";
import { AttendanceTemplateRepository } from "./storage/attendance-template-repository.mjs";
import { migrateFeatureSchema } from "./storage/feature-schema.mjs";
import { PersonalReminderRepository } from "./storage/personal-reminder-repository.mjs";
import { normalizeReminderMinutes } from "./time.mjs";

const RSVP_STATUSES = new Set(["attending", "maybe", "declined"]);

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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
    status: row.status,
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
    mentionEveryone: Boolean(row.mention_everyone),
    status: row.status,
    attempts: Number(row.attempts),
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
    this.personalReminders = new PersonalReminderRepository({ db: this.db, transaction });
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
        status TEXT NOT NULL CHECK(status IN ('active', 'cancelled', 'completed')),
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
        PRIMARY KEY(guild_id, alias_key),
        UNIQUE(guild_id, user_id)
      );
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
      CREATE TABLE IF NOT EXISTS deliveries (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        offset_minutes INTEGER NOT NULL,
        due_at_ms INTEGER NOT NULL,
        mention_everyone INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'skipped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        lease_expires_at_ms INTEGER,
        discord_message_id TEXT,
        last_error_code TEXT,
        sent_at_ms INTEGER,
        PRIMARY KEY(meeting_id, offset_minutes)
      );
      CREATE INDEX IF NOT EXISTS deliveries_due_idx
        ON deliveries(status, next_attempt_at_ms, due_at_ms);
    `);
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
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO meetings(
          id, guild_id, channel_id, message_id, created_by_id, created_by_name,
          title, starts_at_ms, ends_at_ms, time_zone, meeting_url, status,
          reminder_minutes_json, created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        id,
        String(input.guildId),
        String(input.channelId),
        String(input.createdById),
        input.createdByName,
        input.title,
        Number(input.startsAtMs),
        Number(input.endsAtMs),
        input.timeZone || "Asia/Tokyo",
        input.meetingUrl,
        JSON.stringify(reminders),
        now,
        now,
      );
      this.replacePendingDeliveries(id, Number(input.startsAtMs), reminders, input.everyoneOffsets || [0]);
    });
    return this.getMeeting(id);
  }

  replacePendingDeliveries(meetingId, startsAtMs, reminders, everyoneOffsets) {
    this.db.prepare("DELETE FROM deliveries WHERE meeting_id = ? AND status != 'sent'").run(meetingId);
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO deliveries(
        meeting_id, offset_minutes, due_at_ms, mention_everyone, status, next_attempt_at_ms
      ) VALUES(?, ?, ?, ?, 'pending', 0)
    `);
    const everyoneSet = new Set(everyoneOffsets.map(Number));
    for (const offset of normalizeReminderMinutes(reminders)) {
      statement.run(meetingId, offset, startsAtMs - offset * 60_000, everyoneSet.has(offset) ? 1 : 0);
    }
  }

  updateMeeting(id, patch, { everyoneOffsets = [0] } = {}) {
    const current = this.getMeeting(id);
    if (!current) throw new Error("会議が見つかりません");
    if (current.status !== "active") throw new Error("終了または中止済みの会議は更新できません");
    const next = {
      title: patch.title ?? current.title,
      startsAtMs: patch.startsAtMs ?? current.startsAtMs,
      endsAtMs: patch.endsAtMs ?? current.endsAtMs,
      meetingUrl: patch.meetingUrl ?? current.meetingUrl,
      reminderMinutes: normalizeReminderMinutes(patch.reminderMinutes ?? current.reminderMinutes),
    };
    const startsAtChanged = next.startsAtMs !== current.startsAtMs;
    const remindersChanged = JSON.stringify(next.reminderMinutes) !== JSON.stringify(current.reminderMinutes);
    this.transaction(() => {
      this.db.prepare(`
        UPDATE meetings
        SET title = ?, starts_at_ms = ?, ends_at_ms = ?, meeting_url = ?,
            reminder_minutes_json = ?, updated_at_ms = ?
        WHERE id = ?
      `).run(
        next.title,
        next.startsAtMs,
        next.endsAtMs,
        next.meetingUrl,
        JSON.stringify(next.reminderMinutes),
        Date.now(),
        id,
      );
      if (startsAtChanged || remindersChanged) {
        this.replacePendingDeliveries(id, next.startsAtMs, next.reminderMinutes, everyoneOffsets);
      }
    });
    if (startsAtChanged) {
      for (const invitee of this.listMeetingInvitees(id)) {
        const personal = this.personalReminders.getMeetingReminders(id, invitee.userId);
        if (!personal) continue;
        this.personalReminders.replaceMeetingReminders({
          meetingId: id,
          userId: invitee.userId,
          startsAtMs: next.startsAtMs,
          minutes: personal.minutes,
          source: personal.source,
        });
      }
    }
    return this.getMeeting(id);
  }

  updateMeetingUrl(id, meetingUrl) {
    const normalizedId = normalizeMeetingId(id);
    const current = this.getMeeting(normalizedId);
    if (!current) throw new Error("会議が見つかりません");
    if (current.status !== "active") throw new Error("終了または中止済みの会議は更新できません");
    this.db.prepare("UPDATE meetings SET meeting_url = ?, updated_at_ms = ? WHERE id = ?")
      .run(String(meetingUrl), Date.now(), normalizedId);
    return this.getMeeting(normalizedId);
  }

  setMessageId(id, messageId) {
    this.db.prepare("UPDATE meetings SET message_id = ?, updated_at_ms = ? WHERE id = ?")
      .run(String(messageId), Date.now(), id);
  }

  cancelMeeting(id) {
    const result = this.transaction(() => {
      const update = this.db.prepare("UPDATE meetings SET status = 'cancelled', updated_at_ms = ? WHERE id = ? AND status = 'active'")
        .run(Date.now(), id);
      this.db.prepare("UPDATE deliveries SET status = 'skipped' WHERE meeting_id = ? AND status IN ('pending', 'sending')")
        .run(id);
      this.db.prepare("UPDATE personal_deliveries SET status = 'skipped', last_error_code = 'meeting_cancelled' WHERE meeting_id = ? AND status IN ('pending', 'sending')")
        .run(id);
      return update.changes;
    });
    return result > 0 ? this.getMeeting(id) : null;
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
        DELETE FROM member_aliases
        WHERE guild_id = ? AND user_id = ? AND alias_key != ?
      `).run(tenantId, discordUserId, normalized.aliasKey);
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
    const meeting = this.getMeeting(meetingId);
    if (!meeting || meeting.status !== "active") throw new Error("招待できる会議が見つかりません");
    const prepared = [];
    const alreadySent = [];
    const seen = new Set();
    this.transaction(() => {
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
                delivery_error_code = NULL
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
    const meeting = this.getMeeting(meetingId);
    if (!meeting || meeting.status !== "active") throw new Error("回答できる会議が見つかりません");
    this.db.prepare(`
      INSERT INTO rsvps(meeting_id, user_id, display_name, status, updated_at_ms)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(meeting_id, user_id) DO UPDATE SET
        display_name = excluded.display_name,
        status = excluded.status,
        updated_at_ms = excluded.updated_at_ms
    `).run(meeting.id, String(userId), displayName, status, Date.now());
    return this.listRsvps(meeting.id);
  }

  listRsvps(meetingId) {
    return this.db.prepare("SELECT * FROM rsvps WHERE meeting_id = ? ORDER BY updated_at_ms ASC")
      .all(String(meetingId).toUpperCase()).map(mapRsvp);
  }

  claimDueDeliveries({ nowMs = Date.now(), maxLateMinutes = 10, leaseMs = 120_000, limit = 10 } = {}) {
    return this.transaction(() => {
      this.db.prepare(`
        UPDATE deliveries SET status = 'pending', lease_expires_at_ms = NULL
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
        ORDER BY d.due_at_ms ASC
        LIMIT ?
      `).all(nowMs, oldestAllowed, nowMs, limit);
      const claim = this.db.prepare(`
        UPDATE deliveries
        SET status = 'sending', attempts = attempts + 1, lease_expires_at_ms = ?
        WHERE meeting_id = ? AND offset_minutes = ? AND status = 'pending'
      `);
      const claimed = [];
      for (const row of rows) {
        if (claim.run(nowMs + leaseMs, row.meeting_id, row.offset_minutes).changes === 1) {
          claimed.push({
            ...mapDelivery({ ...row, status: "sending", attempts: Number(row.attempts) + 1 }),
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

  markDeliverySent(meetingId, offsetMinutes, { discordMessageId, sentAtMs = Date.now() }) {
    this.db.prepare(`
      UPDATE deliveries
      SET status = 'sent', discord_message_id = ?, sent_at_ms = ?,
          lease_expires_at_ms = NULL, last_error_code = NULL
      WHERE meeting_id = ? AND offset_minutes = ? AND status = 'sending'
    `).run(String(discordMessageId), sentAtMs, meetingId, offsetMinutes);
  }

  markDeliveryFailed(meetingId, offsetMinutes, { errorCode = "send_failed", nowMs = Date.now() } = {}) {
    const row = this.db.prepare("SELECT attempts FROM deliveries WHERE meeting_id = ? AND offset_minutes = ?")
      .get(meetingId, offsetMinutes);
    const attempts = Number(row?.attempts || 1);
    const delayMs = Math.min(15 * 60_000, 15_000 * (2 ** Math.min(attempts - 1, 6)));
    this.db.prepare(`
      UPDATE deliveries
      SET status = 'pending', next_attempt_at_ms = ?, lease_expires_at_ms = NULL,
          last_error_code = ?
      WHERE meeting_id = ? AND offset_minutes = ? AND status = 'sending'
    `).run(nowMs + delayMs, String(errorCode).slice(0, 80), meetingId, offsetMinutes);
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
