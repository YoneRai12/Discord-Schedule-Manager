import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig({ requireSecrets: false });
const database = new DatabaseSync(config.databasePath, { readOnly: true });
try {
  const expected = new Set([
    "meetings",
    "rsvps",
    "member_aliases",
    "meeting_invitees",
    "attendance_templates",
    "attendance_template_members",
    "member_reminder_preferences",
    "meeting_invitee_reminders",
    "personal_deliveries",
  ]);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
    .all("table")
    .map((row) => row.name)
    .filter((name) => expected.has(name));
  const counts = {
    memberAliases: Number(database.prepare("SELECT COUNT(*) AS count FROM member_aliases").get().count),
    invitees: Number(database.prepare("SELECT COUNT(*) AS count FROM meeting_invitees").get().count),
    templates: Number(database.prepare("SELECT COUNT(*) AS count FROM attendance_templates").get().count),
    personalPreferences: Number(database.prepare("SELECT COUNT(*) AS count FROM member_reminder_preferences").get().count),
  };
  console.log(JSON.stringify({ tables, counts }));
} finally {
  database.close();
}
