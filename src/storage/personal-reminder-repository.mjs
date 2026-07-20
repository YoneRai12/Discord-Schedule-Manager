import crypto from "node:crypto";
import { normalizePersonalReminderMinutes } from "../personal-reminders.mjs";

const SOURCES = new Set(["preference", "override", "none"]);

function requireId(value, label) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 100 || /[\u0000-\u001F\u007F]/u.test(id)) {
    throw new Error(`${label}が正しくありません`);
  }
  return id;
}

function parseMinutes(value) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("invalid reminder json");
    const normalized = normalizePersonalReminderMinutes(parsed);
    if (normalized.length !== new Set(parsed.map(Number)).size) throw new Error("invalid reminder values");
    return normalized;
  } catch {
    throw Object.assign(new Error("保存済みの個別通知設定が破損しています"), {
      code: "corrupt_reminder_json",
    });
  }
}

function cleanErrorCode(value) {
  return String(value ?? "send_failed")
    .replace(/[^a-zA-Z0-9_.:-]/gu, "_")
    .slice(0, 80) || "send_failed";
}

function mapPreference(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    minutes: parseMinutes(row.minutes_json),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function mapMeetingReminders(row) {
  if (!row) return null;
  return {
    meetingId: row.meeting_id,
    userId: row.user_id,
    minutes: parseMinutes(row.minutes_json),
    source: row.source,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function mapDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    meetingId: row.meeting_id,
    userId: row.user_id,
    offsetMinutes: Number(row.offset_minutes),
    dueAtMs: Number(row.due_at_ms),
    status: row.status,
    scheduleRevision: Number(row.schedule_revision || 0),
    attempts: Number(row.attempts),
    nextAttemptAtMs: Number(row.next_attempt_at_ms),
    leaseExpiresAtMs: row.lease_expires_at_ms == null ? null : Number(row.lease_expires_at_ms),
    claimToken: row.claim_token || null,
    discordMessageId: row.discord_message_id || null,
    lastErrorCode: row.last_error_code || null,
    sentAtMs: row.sent_at_ms == null ? null : Number(row.sent_at_ms),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class PersonalReminderRepository {
  constructor({ db, transaction, completeEndedMeetings = null }) {
    if (!db?.prepare) throw new TypeError("SQLiteデータベースが必要です");
    if (typeof transaction !== "function") throw new TypeError("transaction関数が必要です");
    this.db = db;
    this.transaction = transaction;
    this.completeEndedMeetings = typeof completeEndedMeetings === "function" ? completeEndedMeetings : null;
    this.migrateDeliverySchema();
  }

  migrateDeliverySchema() {
    const info = this.db.prepare("PRAGMA table_info(personal_deliveries)").all();
    const columns = new Set(info.map((row) => row.name));
    if (columns.has("schedule_revision") && columns.has("claim_token")) return;
    const revisionExpression = columns.has("schedule_revision")
      ? "schedule_revision"
      : "COALESCE((SELECT schedule_revision FROM meetings WHERE meetings.id = personal_deliveries.meeting_id), 0)";
    const claimExpression = columns.has("claim_token") ? "claim_token" : "NULL";
    this.transaction(() => {
      this.db.exec(`
        DROP INDEX IF EXISTS personal_deliveries_due_idx;
        DROP INDEX IF EXISTS personal_deliveries_invitee_idx;
        ALTER TABLE personal_deliveries RENAME TO personal_deliveries_before_revision;
        CREATE TABLE personal_deliveries (
          id TEXT PRIMARY KEY,
          meeting_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          schedule_revision INTEGER NOT NULL DEFAULT 0 CHECK(schedule_revision >= 0),
          offset_minutes INTEGER NOT NULL CHECK(offset_minutes >= 0),
          due_at_ms INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'skipped')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
          lease_expires_at_ms INTEGER,
          claim_token TEXT,
          discord_message_id TEXT,
          last_error_code TEXT,
          sent_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          UNIQUE(meeting_id, user_id, schedule_revision, offset_minutes),
          FOREIGN KEY(meeting_id, user_id)
            REFERENCES meeting_invitees(meeting_id, user_id) ON DELETE CASCADE
        );
        INSERT INTO personal_deliveries(
          id, meeting_id, user_id, schedule_revision, offset_minutes, due_at_ms,
          status, attempts, next_attempt_at_ms, lease_expires_at_ms, claim_token,
          discord_message_id, last_error_code, sent_at_ms, created_at_ms, updated_at_ms
        )
        SELECT
          id, meeting_id, user_id, ${revisionExpression}, offset_minutes, due_at_ms,
          status, attempts, next_attempt_at_ms, lease_expires_at_ms, ${claimExpression},
          discord_message_id, last_error_code, sent_at_ms, created_at_ms, updated_at_ms
        FROM personal_deliveries_before_revision AS personal_deliveries;
        DROP TABLE personal_deliveries_before_revision;
        CREATE INDEX personal_deliveries_due_idx
          ON personal_deliveries(status, next_attempt_at_ms, due_at_ms);
        CREATE INDEX personal_deliveries_invitee_idx
          ON personal_deliveries(meeting_id, user_id, due_at_ms);
      `);
    });
  }

  setMemberPreference(guildId, userId, minutes, { nowMs = Date.now() } = {}) {
    const tenantId = requireId(guildId, "Guild ID");
    const memberId = requireId(userId, "DiscordユーザーID");
    const normalized = normalizePersonalReminderMinutes(minutes);
    this.db.prepare(`
      INSERT INTO member_reminder_preferences(guild_id, user_id, minutes_json, updated_at_ms)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        minutes_json = excluded.minutes_json,
        updated_at_ms = excluded.updated_at_ms
    `).run(tenantId, memberId, JSON.stringify(normalized), Number(nowMs));
    return this.getMemberPreference(tenantId, memberId);
  }

  getMemberPreference(guildId, userId) {
    return mapPreference(this.db.prepare(`
      SELECT * FROM member_reminder_preferences WHERE guild_id = ? AND user_id = ?
    `).get(requireId(guildId, "Guild ID"), requireId(userId, "DiscordユーザーID")));
  }

  deleteMemberPreference(guildId, userId) {
    return this.db.prepare(`
      DELETE FROM member_reminder_preferences WHERE guild_id = ? AND user_id = ?
    `).run(requireId(guildId, "Guild ID"), requireId(userId, "DiscordユーザーID")).changes > 0;
  }

  getMeetingReminders(meetingId, userId) {
    return mapMeetingReminders(this.db.prepare(`
      SELECT * FROM meeting_invitee_reminders WHERE meeting_id = ? AND user_id = ?
    `).get(requireId(meetingId, "会議ID").toUpperCase(), requireId(userId, "DiscordユーザーID")));
  }

  copyPreferenceToMeeting({ meetingId, guildId, userId, startsAtMs, fallbackMinutes = [], nowMs = Date.now() }) {
    const preference = this.getMemberPreference(guildId, userId);
    return this.replaceMeetingReminders({
      meetingId,
      userId,
      startsAtMs,
      minutes: preference?.minutes ?? fallbackMinutes,
      source: preference ? "preference" : (fallbackMinutes.length ? "preference" : "none"),
      nowMs,
    });
  }

  replaceMeetingReminders({ meetingId, userId, startsAtMs, minutes, source = "override", nowMs = Date.now() }) {
    return this.transaction(() => this.replaceMeetingRemindersInternal({
      meetingId,
      userId,
      startsAtMs,
      minutes,
      source,
      nowMs,
    }));
  }

  replaceMeetingRemindersInternal({ meetingId, userId, startsAtMs, minutes, source = "override", nowMs = Date.now() }) {
    const id = requireId(meetingId, "会議ID").toUpperCase();
    const memberId = requireId(userId, "DiscordユーザーID");
    if (!SOURCES.has(source)) throw new Error("個別通知の保存元が正しくありません");
    const start = Number(startsAtMs);
    if (!Number.isSafeInteger(start) || start <= 0) throw new Error("会議開始日時が正しくありません");
    const normalized = normalizePersonalReminderMinutes(minutes);
    const actualSource = normalized.length ? source : "none";
    const timestamp = Number(nowMs);
    const result = (() => {
      const invitee = this.db.prepare(`
        SELECT m.schedule_revision
        FROM meeting_invitees i
        JOIN meetings m ON m.id = i.meeting_id
        WHERE i.meeting_id = ? AND i.user_id = ? AND m.status = 'active'
      `).get(id, memberId);
      if (!invitee) throw new Error("会議の招待者が見つかりません");
      const revision = Number(invitee.schedule_revision || 0);
      const existing = this.db.prepare(`
        SELECT created_at_ms FROM meeting_invitee_reminders WHERE meeting_id = ? AND user_id = ?
      `).get(id, memberId);
      this.db.prepare(`
        INSERT INTO meeting_invitee_reminders(
          meeting_id, user_id, minutes_json, source, created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(meeting_id, user_id) DO UPDATE SET
          minutes_json = excluded.minutes_json,
          source = excluded.source,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        id,
        memberId,
        JSON.stringify(normalized),
        actualSource,
        existing ? Number(existing.created_at_ms) : timestamp,
        timestamp,
      );
      this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
            last_error_code = 'schedule_superseded', updated_at_ms = ?
        WHERE meeting_id = ? AND user_id = ? AND schedule_revision != ?
          AND status IN ('pending', 'sending')
      `).run(timestamp, id, memberId, revision);
      const desired = new Set(normalized);
      const currentRows = this.db.prepare(`
        SELECT offset_minutes FROM personal_deliveries
        WHERE meeting_id = ? AND user_id = ? AND schedule_revision = ?
      `).all(id, memberId, revision);
      const skip = this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
            last_error_code = 'schedule_changed', updated_at_ms = ?
        WHERE meeting_id = ? AND user_id = ? AND schedule_revision = ?
          AND offset_minutes = ? AND status IN ('pending', 'sending')
      `);
      for (const row of currentRows) {
        if (!desired.has(Number(row.offset_minutes))) {
          skip.run(timestamp, id, memberId, revision, row.offset_minutes);
        }
      }
      const insert = this.db.prepare(`
        INSERT INTO personal_deliveries(
          id, meeting_id, user_id, schedule_revision, offset_minutes, due_at_ms, status,
          attempts, next_attempt_at_ms, lease_expires_at_ms, claim_token,
          discord_message_id, last_error_code, sent_at_ms, created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(meeting_id, user_id, schedule_revision, offset_minutes) DO UPDATE SET
          due_at_ms = excluded.due_at_ms,
          status = CASE
            WHEN personal_deliveries.status IN ('sent', 'sending') THEN personal_deliveries.status
            ELSE 'pending'
          END,
          attempts = CASE WHEN personal_deliveries.status = 'skipped' THEN 0 ELSE personal_deliveries.attempts END,
          next_attempt_at_ms = CASE WHEN personal_deliveries.status = 'skipped' THEN 0 ELSE personal_deliveries.next_attempt_at_ms END,
          lease_expires_at_ms = CASE WHEN personal_deliveries.status = 'sending' THEN personal_deliveries.lease_expires_at_ms ELSE NULL END,
          claim_token = CASE WHEN personal_deliveries.status = 'sending' THEN personal_deliveries.claim_token ELSE NULL END,
          last_error_code = CASE WHEN personal_deliveries.status IN ('sent', 'sending') THEN personal_deliveries.last_error_code ELSE NULL END,
          updated_at_ms = excluded.updated_at_ms
      `);
      for (const offset of normalized) {
        insert.run(
          crypto.randomUUID(),
          id,
          memberId,
          revision,
          offset,
          start - offset * 60_000,
          timestamp,
          timestamp,
        );
      }
      return {
        reminders: this.getMeetingReminders(id, memberId),
        deliveries: this.listMeetingDeliveries(id, memberId),
      };
    })();
    return result;
  }

  invalidateSendingClaimsForMeeting(meetingId, { nowMs = Date.now(), reason = "content_superseded" } = {}) {
    return this.db.prepare(`
      UPDATE personal_deliveries
      SET status = 'pending', next_attempt_at_ms = 0,
          lease_expires_at_ms = NULL, claim_token = NULL,
          last_error_code = ?, updated_at_ms = ?
      WHERE meeting_id = ? AND status = 'sending'
    `).run(
      cleanErrorCode(reason),
      Number(nowMs),
      requireId(meetingId, "会議ID").toUpperCase(),
    ).changes;
  }

  listMeetingDeliveries(meetingId, userId = null) {
    const id = requireId(meetingId, "会議ID").toUpperCase();
    const rows = userId == null
      ? this.db.prepare(`
        SELECT * FROM personal_deliveries WHERE meeting_id = ? ORDER BY due_at_ms ASC, user_id ASC
      `).all(id)
      : this.db.prepare(`
        SELECT * FROM personal_deliveries
        WHERE meeting_id = ? AND user_id = ? ORDER BY due_at_ms ASC
      `).all(id, requireId(userId, "DiscordユーザーID"));
    return rows.map(mapDelivery);
  }

  claimDueDeliveries({ nowMs = Date.now(), maxLateMinutes = 10, leaseMs = 120_000, limit = 20 } = {}) {
    const now = Number(nowMs);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("現在日時が正しくありません");
    const lateMinutes = Number(maxLateMinutes);
    const safeLateMinutes = Number.isFinite(lateMinutes) ? Math.max(0, lateMinutes) : 10;
    const oldestAllowed = now - safeLateMinutes * 60_000;
    const requestedLimit = Math.trunc(Number(limit));
    const safeLimit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 20));
    const requestedLease = Math.trunc(Number(leaseMs));
    const safeLeaseMs = Math.max(1_000, Number.isFinite(requestedLease) ? requestedLease : 120_000);
    this.completeEndedMeetings?.({ nowMs: now });
    return this.transaction(() => {
      this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'skipped', lease_expires_at_ms = NULL, claim_token = NULL,
            last_error_code = 'schedule_superseded', updated_at_ms = ?
        WHERE status IN ('pending', 'sending')
          AND EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = personal_deliveries.meeting_id
              AND (m.status != 'active' OR m.schedule_revision != personal_deliveries.schedule_revision)
          )
      `).run(now);
      this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'pending', lease_expires_at_ms = NULL, claim_token = NULL, updated_at_ms = ?
        WHERE status = 'sending' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
      `).run(now, now);
      this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'skipped', last_error_code = 'too_late', updated_at_ms = ?
        WHERE status = 'pending' AND due_at_ms < ?
      `).run(now, oldestAllowed);
      this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'skipped', last_error_code = 'meeting_inactive', updated_at_ms = ?
        WHERE status IN ('pending', 'sending')
          AND EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = personal_deliveries.meeting_id AND m.status != 'active'
          )
      `).run(now);
      this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'skipped', last_error_code = 'rsvp_declined', updated_at_ms = ?
        WHERE status IN ('pending', 'sending')
          AND EXISTS (
            SELECT 1 FROM rsvps r
            WHERE r.meeting_id = personal_deliveries.meeting_id
              AND r.user_id = personal_deliveries.user_id
              AND r.status = 'declined'
          )
      `).run(now);
      const rows = this.db.prepare(`
        SELECT p.*, m.guild_id, m.title, m.starts_at_ms, m.ends_at_ms,
               m.time_zone, m.meeting_url, i.display_name
        FROM personal_deliveries p
        JOIN meetings m ON m.id = p.meeting_id
        JOIN meeting_invitees i ON i.meeting_id = p.meeting_id AND i.user_id = p.user_id
        WHERE p.status = 'pending'
          AND p.due_at_ms <= ?
          AND p.due_at_ms >= ?
          AND p.next_attempt_at_ms <= ?
          AND m.status = 'active'
          AND p.schedule_revision = m.schedule_revision
          AND NOT EXISTS (
            SELECT 1 FROM rsvps r
            WHERE r.meeting_id = p.meeting_id
              AND r.user_id = p.user_id
              AND r.status = 'declined'
          )
        ORDER BY p.due_at_ms ASC, p.id ASC
        LIMIT ?
      `).all(now, oldestAllowed, now, safeLimit);
      const claim = this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'sending', attempts = attempts + 1,
            lease_expires_at_ms = ?, claim_token = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM meetings m
            WHERE m.id = personal_deliveries.meeting_id AND m.status = 'active'
              AND m.schedule_revision = personal_deliveries.schedule_revision
          )
      `);
      const claimed = [];
      for (const row of rows) {
        const claimToken = crypto.randomUUID();
        if (claim.run(now + safeLeaseMs, claimToken, now, row.id).changes !== 1) continue;
        claimed.push({
          ...mapDelivery({
            ...row,
            status: "sending",
            attempts: Number(row.attempts) + 1,
            claim_token: claimToken,
          }),
          guildId: row.guild_id,
          displayName: row.display_name,
          title: row.title,
          startsAtMs: Number(row.starts_at_ms),
          endsAtMs: Number(row.ends_at_ms),
          timeZone: row.time_zone,
          meetingUrl: row.meeting_url,
        });
      }
      return claimed;
    });
  }

  isClaimCurrent(delivery) {
    if (!delivery?.id || delivery.scheduleRevision == null || !delivery.claimToken) return false;
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM personal_deliveries p
      JOIN meetings m ON m.id = p.meeting_id
      WHERE p.id = ? AND p.schedule_revision = ?
        AND p.status = 'sending' AND p.claim_token = ?
        AND m.status = 'active' AND m.schedule_revision = p.schedule_revision
      LIMIT 1
    `).get(String(delivery.id), Number(delivery.scheduleRevision), String(delivery.claimToken)));
  }

  markSent(deliveryId, {
    discordMessageId,
    sentAtMs = Date.now(),
    scheduleRevision = null,
    claimToken = null,
  }) {
    const id = requireId(deliveryId, "配信ID");
    const messageId = requireId(discordMessageId, "DiscordメッセージID");
    const result = this.db.prepare(`
      UPDATE personal_deliveries
      SET status = 'sent', discord_message_id = ?, sent_at_ms = ?,
          lease_expires_at_ms = NULL, claim_token = NULL,
          last_error_code = NULL, updated_at_ms = ?
      WHERE id = ? AND status = 'sending'
        AND (? IS NULL OR schedule_revision = ?)
        AND (? IS NULL OR claim_token = ?)
    `).run(
      messageId,
      Number(sentAtMs),
      Number(sentAtMs),
      id,
      scheduleRevision,
      scheduleRevision,
      claimToken,
      claimToken,
    );
    return result.changes === 1;
  }

  markFailed(deliveryId, {
    errorCode = "send_failed",
    failedAtMs = Date.now(),
    maxAttempts = 6,
    retryable = true,
    scheduleRevision = null,
    claimToken = null,
  } = {}) {
    const id = requireId(deliveryId, "配信ID");
    const row = this.db.prepare(`
      SELECT attempts FROM personal_deliveries
      WHERE id = ? AND status = 'sending'
        AND (? IS NULL OR schedule_revision = ?)
        AND (? IS NULL OR claim_token = ?)
    `).get(id, scheduleRevision, scheduleRevision, claimToken, claimToken);
    if (!row) return false;
    const now = Number(failedAtMs);
    const attempts = Number(row.attempts);
    const requestedLimit = Math.trunc(Number(maxAttempts));
    const attemptLimit = Number.isFinite(requestedLimit) ? requestedLimit : 6;
    if (!retryable || attemptLimit <= 0 || attempts >= Math.max(1, attemptLimit)) {
      return this.db.prepare(`
        UPDATE personal_deliveries
        SET status = 'skipped', lease_expires_at_ms = NULL,
            claim_token = NULL, last_error_code = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'sending'
          AND (? IS NULL OR schedule_revision = ?)
          AND (? IS NULL OR claim_token = ?)
      `).run(
        cleanErrorCode(errorCode), now, id,
        scheduleRevision, scheduleRevision, claimToken, claimToken,
      ).changes === 1;
    }
    const delayMs = Math.min(15 * 60_000, 15_000 * (2 ** Math.min(attempts - 1, 6)));
    return this.db.prepare(`
      UPDATE personal_deliveries
      SET status = 'pending', next_attempt_at_ms = ?, lease_expires_at_ms = NULL,
          claim_token = NULL, last_error_code = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'sending'
        AND (? IS NULL OR schedule_revision = ?)
        AND (? IS NULL OR claim_token = ?)
    `).run(
      now + delayMs, cleanErrorCode(errorCode), now, id,
      scheduleRevision, scheduleRevision, claimToken, claimToken,
    ).changes === 1;
  }

  markSkipped(deliveryId, { reason = "skipped", nowMs = Date.now() } = {}) {
    return this.db.prepare(`
      UPDATE personal_deliveries
      SET status = 'skipped', lease_expires_at_ms = NULL,
          claim_token = NULL, last_error_code = ?, updated_at_ms = ?
      WHERE id = ? AND status IN ('pending', 'sending')
    `).run(cleanErrorCode(reason), Number(nowMs), requireId(deliveryId, "配信ID")).changes === 1;
  }
}
