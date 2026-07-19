import { normalizeTemplateName } from "../attendance-templates.mjs";

const MAX_TEMPLATE_MEMBERS = 50;

function requireId(value, label) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 100 || /[\u0000-\u001F\u007F]/u.test(id)) {
    throw new Error(`${label}が正しくありません`);
  }
  return id;
}

function cleanDisplayName(value) {
  const displayName = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!displayName) throw new Error("表示名が必要です");
  return [...displayName].slice(0, 80).join("");
}

function normalizeMembers(members) {
  if (!Array.isArray(members)) throw new Error("メンバー一覧が必要です");
  const normalized = [];
  const seen = new Set();
  for (const member of members) {
    const userId = requireId(member?.userId, "DiscordユーザーID");
    if (seen.has(userId)) continue;
    seen.add(userId);
    normalized.push({ userId, displayName: cleanDisplayName(member?.displayName) });
  }
  if (normalized.length > MAX_TEMPLATE_MEMBERS) {
    throw new Error(`1つのテンプレートに登録できるのは${MAX_TEMPLATE_MEMBERS}人までです`);
  }
  return normalized;
}

function mapTemplate(row, members = []) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    name: row.name,
    nameKey: row.name_key,
    isDefault: Boolean(row.is_default),
    createdById: row.created_by_id,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    members,
  };
}

function mapMember(row) {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    sortOrder: Number(row.sort_order),
    addedAtMs: Number(row.added_at_ms),
  };
}

export class AttendanceTemplateRepository {
  constructor({ db, transaction }) {
    if (!db?.prepare) throw new TypeError("SQLiteデータベースが必要です");
    if (typeof transaction !== "function") throw new TypeError("transaction関数が必要です");
    this.db = db;
    this.transaction = transaction;
  }

  saveTemplate(guildId, { name, members, createdById, makeDefault = false, nowMs = Date.now() }) {
    const tenantId = requireId(guildId, "Guild ID");
    const creatorId = requireId(createdById, "作成者ID");
    const normalizedName = normalizeTemplateName(name);
    const normalizedMembers = normalizeMembers(members);
    const timestamp = Number(nowMs);
    return this.transaction(() => {
      const current = this.db.prepare(`
        SELECT * FROM attendance_templates WHERE guild_id = ? AND name_key = ?
      `).get(tenantId, normalizedName.nameKey);
      const hasDefault = Boolean(this.db.prepare(`
        SELECT 1 FROM attendance_templates WHERE guild_id = ? AND is_default = 1
      `).get(tenantId));
      const shouldBeDefault = Boolean(makeDefault || current?.is_default || !hasDefault);
      if (shouldBeDefault) {
        this.db.prepare("UPDATE attendance_templates SET is_default = 0 WHERE guild_id = ?")
          .run(tenantId);
      }
      this.db.prepare(`
        INSERT INTO attendance_templates(
          guild_id, name_key, name, is_default, created_by_id, created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, name_key) DO UPDATE SET
          name = excluded.name,
          is_default = excluded.is_default,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        tenantId,
        normalizedName.nameKey,
        normalizedName.name,
        shouldBeDefault ? 1 : 0,
        creatorId,
        current ? Number(current.created_at_ms) : timestamp,
        timestamp,
      );
      this.db.prepare(`
        DELETE FROM attendance_template_members WHERE guild_id = ? AND template_name_key = ?
      `).run(tenantId, normalizedName.nameKey);
      const insert = this.db.prepare(`
        INSERT INTO attendance_template_members(
          guild_id, template_name_key, user_id, display_name, sort_order, added_at_ms
        ) VALUES(?, ?, ?, ?, ?, ?)
      `);
      normalizedMembers.forEach((member, index) => {
        insert.run(tenantId, normalizedName.nameKey, member.userId, member.displayName, index, timestamp);
      });
      return this.getTemplate(tenantId, normalizedName.name);
    });
  }

  getTemplate(guildId, name) {
    const tenantId = requireId(guildId, "Guild ID");
    const { nameKey } = normalizeTemplateName(name);
    const row = this.db.prepare(`
      SELECT * FROM attendance_templates WHERE guild_id = ? AND name_key = ?
    `).get(tenantId, nameKey);
    if (!row) return null;
    return mapTemplate(row, this.listTemplateMembers(tenantId, nameKey, { normalizedKey: true }));
  }

  getDefaultTemplate(guildId) {
    const tenantId = requireId(guildId, "Guild ID");
    const row = this.db.prepare(`
      SELECT * FROM attendance_templates WHERE guild_id = ? AND is_default = 1
    `).get(tenantId);
    if (!row) return null;
    return mapTemplate(row, this.listTemplateMembers(tenantId, row.name_key, { normalizedKey: true }));
  }

  listTemplates(guildId) {
    const tenantId = requireId(guildId, "Guild ID");
    return this.db.prepare(`
      SELECT t.*, COUNT(m.user_id) AS member_count
      FROM attendance_templates t
      LEFT JOIN attendance_template_members m
        ON m.guild_id = t.guild_id AND m.template_name_key = t.name_key
      WHERE t.guild_id = ?
      GROUP BY t.guild_id, t.name_key
      ORDER BY t.is_default DESC, t.name_key ASC
    `).all(tenantId).map((row) => ({
      ...mapTemplate(row),
      memberCount: Number(row.member_count),
    }));
  }

  listTemplateMembers(guildId, name, { normalizedKey = false } = {}) {
    const tenantId = requireId(guildId, "Guild ID");
    const nameKey = normalizedKey ? String(name) : normalizeTemplateName(name).nameKey;
    return this.db.prepare(`
      SELECT * FROM attendance_template_members
      WHERE guild_id = ? AND template_name_key = ?
      ORDER BY sort_order ASC, user_id ASC
    `).all(tenantId, nameKey).map(mapMember);
  }

  setDefaultTemplate(guildId, name, { nowMs = Date.now() } = {}) {
    const tenantId = requireId(guildId, "Guild ID");
    const { nameKey } = normalizeTemplateName(name);
    return this.transaction(() => {
      const exists = this.db.prepare(`
        SELECT 1 FROM attendance_templates WHERE guild_id = ? AND name_key = ?
      `).get(tenantId, nameKey);
      if (!exists) throw new Error("参加者テンプレートが見つかりません");
      this.db.prepare("UPDATE attendance_templates SET is_default = 0 WHERE guild_id = ?")
        .run(tenantId);
      this.db.prepare(`
        UPDATE attendance_templates SET is_default = 1, updated_at_ms = ?
        WHERE guild_id = ? AND name_key = ?
      `).run(Number(nowMs), tenantId, nameKey);
      return this.getTemplate(tenantId, name);
    });
  }

  deleteTemplate(guildId, name, { nowMs = Date.now() } = {}) {
    const tenantId = requireId(guildId, "Guild ID");
    const { nameKey } = normalizeTemplateName(name);
    return this.transaction(() => {
      const current = this.db.prepare(`
        SELECT is_default FROM attendance_templates WHERE guild_id = ? AND name_key = ?
      `).get(tenantId, nameKey);
      if (!current) return false;
      this.db.prepare(`
        DELETE FROM attendance_templates WHERE guild_id = ? AND name_key = ?
      `).run(tenantId, nameKey);
      if (current.is_default) {
        const replacement = this.db.prepare(`
          SELECT name_key FROM attendance_templates
          WHERE guild_id = ? ORDER BY updated_at_ms DESC, name_key ASC LIMIT 1
        `).get(tenantId);
        if (replacement) {
          this.db.prepare(`
            UPDATE attendance_templates SET is_default = 1, updated_at_ms = ?
            WHERE guild_id = ? AND name_key = ?
          `).run(Number(nowMs), tenantId, replacement.name_key);
        }
      }
      return true;
    });
  }

  copyMembersToMeetingInvitees(guildId, name, meetingId, invitedById, { nowMs = Date.now() } = {}) {
    const tenantId = requireId(guildId, "Guild ID");
    const id = requireId(meetingId, "会議ID").toUpperCase();
    const inviterId = requireId(invitedById, "招待者ID");
    const template = name ? this.getTemplate(tenantId, name) : this.getDefaultTemplate(tenantId);
    if (!template) throw new Error(name ? "参加者テンプレートが見つかりません" : "既定の参加者テンプレートがありません");
    const timestamp = Number(nowMs);
    return this.transaction(() => {
      const meeting = this.db.prepare(`
        SELECT id FROM meetings WHERE id = ? AND guild_id = ? AND status = 'active'
      `).get(id, tenantId);
      if (!meeting) throw new Error("招待できる会議が見つかりません");
      const prepared = [];
      const alreadySent = [];
      const upsert = this.db.prepare(`
        INSERT INTO meeting_invitees(
          meeting_id, user_id, display_name, invited_by_id, delivery_status,
          delivery_error_code, dm_message_id, created_at_ms, delivered_at_ms
        ) VALUES(?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)
        ON CONFLICT(meeting_id, user_id) DO UPDATE SET
          display_name = excluded.display_name,
          invited_by_id = excluded.invited_by_id,
          delivery_status = CASE
            WHEN meeting_invitees.delivery_status = 'sent' THEN 'sent' ELSE 'pending'
          END,
          delivery_error_code = CASE
            WHEN meeting_invitees.delivery_status = 'sent' THEN meeting_invitees.delivery_error_code ELSE NULL
          END
      `);
      for (const member of template.members) {
        const current = this.db.prepare(`
          SELECT delivery_status FROM meeting_invitees WHERE meeting_id = ? AND user_id = ?
        `).get(id, member.userId);
        upsert.run(id, member.userId, member.displayName, inviterId, timestamp);
        (current?.delivery_status === "sent" ? alreadySent : prepared).push(member);
      }
      return { template, prepared, alreadySent };
    });
  }
}

export { MAX_TEMPLATE_MEMBERS };
