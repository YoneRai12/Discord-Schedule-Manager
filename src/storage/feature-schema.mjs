export function migrateFeatureSchema(db, transaction = (callback) => callback()) {
  if (!db?.exec || !db?.prepare) throw new TypeError("SQLiteデータベースが必要です");
  if (typeof transaction !== "function") throw new TypeError("transaction関数が必要です");

  return transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attendance_templates (
        guild_id TEXT NOT NULL,
        name_key TEXT NOT NULL,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
        created_by_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(guild_id, name_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS attendance_templates_one_default_idx
        ON attendance_templates(guild_id) WHERE is_default = 1;
      CREATE INDEX IF NOT EXISTS attendance_templates_list_idx
        ON attendance_templates(guild_id, name_key);

      CREATE TABLE IF NOT EXISTS attendance_template_members (
        guild_id TEXT NOT NULL,
        template_name_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
        added_at_ms INTEGER NOT NULL,
        PRIMARY KEY(guild_id, template_name_key, user_id),
        FOREIGN KEY(guild_id, template_name_key)
          REFERENCES attendance_templates(guild_id, name_key) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS attendance_template_members_order_idx
        ON attendance_template_members(guild_id, template_name_key, sort_order);

      CREATE TABLE IF NOT EXISTS member_reminder_preferences (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        minutes_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS meeting_invitee_reminders (
        meeting_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        minutes_json TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('preference', 'override', 'none')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(meeting_id, user_id),
        FOREIGN KEY(meeting_id, user_id)
          REFERENCES meeting_invitees(meeting_id, user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS personal_deliveries (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        offset_minutes INTEGER NOT NULL CHECK(offset_minutes >= 0),
        due_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'skipped')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        lease_expires_at_ms INTEGER,
        discord_message_id TEXT,
        last_error_code TEXT,
        sent_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(meeting_id, user_id, offset_minutes),
        FOREIGN KEY(meeting_id, user_id)
          REFERENCES meeting_invitees(meeting_id, user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS personal_deliveries_due_idx
        ON personal_deliveries(status, next_attempt_at_ms, due_at_ms);
      CREATE INDEX IF NOT EXISTS personal_deliveries_invitee_idx
        ON personal_deliveries(meeting_id, user_id, due_at_ms);
    `);
  });
}
