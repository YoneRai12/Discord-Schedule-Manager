import { DatabaseSync } from "node:sqlite";

const databasePath = process.argv[2] || "data/meetings.sqlite3";
const database = new DatabaseSync(databasePath, { readOnly: true });

function groupedCounts(sql) {
  return Object.fromEntries(database.prepare(sql).all().map((row) => [row.key, Number(row.count)]));
}

try {
  const activeMeetings = database.prepare(`
    SELECT meeting_url FROM meetings WHERE status = 'active' ORDER BY starts_at_ms
  `).all();
  const hostCounts = {};
  for (const meeting of activeMeetings) {
    let host = "invalid";
    try {
      host = new URL(meeting.meeting_url).hostname.toLowerCase();
    } catch {
      // URL本体は出力せず、形式不正の件数だけを残す。
    }
    hostCounts[host] = (hostCounts[host] || 0) + 1;
  }

  console.log(JSON.stringify({
    activeMeetings: activeMeetings.length,
    hostCounts,
    rsvps: groupedCounts("SELECT status AS key, COUNT(*) AS count FROM rsvps GROUP BY status"),
    groupDeliveries: groupedCounts("SELECT status AS key, COUNT(*) AS count FROM deliveries GROUP BY status"),
    personalDeliveries: groupedCounts("SELECT status AS key, COUNT(*) AS count FROM personal_deliveries GROUP BY status"),
    invitees: groupedCounts("SELECT delivery_status AS key, COUNT(*) AS count FROM meeting_invitees GROUP BY delivery_status"),
    groupOffsets: database.prepare(`
      SELECT offset_minutes AS offsetMinutes, status, attempts
      FROM deliveries ORDER BY offset_minutes DESC
    `).all(),
    personalReminderRows: Number(database.prepare("SELECT COUNT(*) AS count FROM meeting_invitee_reminders").get().count),
  }));
} finally {
  database.close();
}
