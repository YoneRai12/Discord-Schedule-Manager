import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`${name} が設定されていません`);
  }
  return value;
}

function integer(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} は ${min}〜${max} の整数で指定してください`);
  }
  return value;
}

function boolean(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} は true または false で指定してください`);
}

export function parseIntegerList(value, { min = 0, max = 10_080, maxItems = 12 } = {}) {
  const items = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number.parseInt(item, 10));
  if (items.some((item) => !Number.isSafeInteger(item) || item < min || item > max)) {
    throw new Error(`整数リストは ${min}〜${max} の範囲で指定してください`);
  }
  return [...new Set(items)].slice(0, maxItems).sort((a, b) => b - a);
}

function snowflakeList(name) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return [];
  const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.some((value) => !/^\d{16,20}$/.test(value))) {
    throw new Error(`${name} にはDiscordのロールIDをカンマ区切りで指定してください`);
  }
  return values;
}

export function loadConfig({ requireSecrets = true } = {}) {
  const defaultReminders = parseIntegerList(process.env.MEETING_DEFAULT_REMINDERS_MINUTES || "30,0");
  const personalDefaultReminders = parseIntegerList(
    process.env.MEETING_PERSONAL_DEFAULT_REMINDERS_MINUTES || "60,10",
    { min: 0, max: 10_080, maxItems: 6 },
  );
  const everyoneOffsets = parseIntegerList(process.env.MEETING_EVERYONE_OFFSETS_MINUTES || "0");
  const dataDir = path.resolve(PROJECT_ROOT, process.env.MEETING_DATA_DIR || "data");
  const serviceAccountFile = String(process.env.GOOGLE_SERVICE_ACCOUNT_FILE ?? "").trim();

  return {
    projectRoot: PROJECT_ROOT,
    discordToken: requireSecrets ? required("DISCORD_BOT_TOKEN") : String(process.env.DISCORD_BOT_TOKEN ?? "").trim(),
    guildId: requireSecrets ? required("DISCORD_GUILD_ID") : String(process.env.DISCORD_GUILD_ID ?? "").trim(),
    creatorRoleIds: snowflakeList("MEETING_CREATOR_ROLE_IDS"),
    timeZone: "Asia/Tokyo",
    defaultDurationMinutes: integer("MEETING_DEFAULT_DURATION_MINUTES", 60, { min: 5, max: 1_440 }),
    defaultReminders,
    personalDefaultReminders,
    everyoneOffsets,
    schedulerIntervalSeconds: integer("MEETING_SCHEDULER_INTERVAL_SECONDS", 15, { min: 5, max: 300 }),
    maxLateMinutes: integer("MEETING_MAX_LATE_MINUTES", 10, { min: 0, max: 1_440 }),
    dataDir,
    databasePath: path.join(dataDir, "meetings.sqlite3"),
    openaiApiKey: String(process.env.OPENAI_API_KEY ?? "").trim(),
    openaiModel: String(process.env.OPENAI_MEETING_MODEL || "gpt-5.4-nano").trim(),
    openaiMaxOutputTokens: integer("OPENAI_MAX_OUTPUT_TOKENS", 1_200, { min: 200, max: 8_000 }),
    spreadsheetId: String(process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? "").trim(),
    googleServiceAccountFile: serviceAccountFile ? path.resolve(PROJECT_ROOT, serviceAccountFile) : "",
    syncMeetingUrlsToSheets: boolean("GOOGLE_SHEETS_SYNC_URLS", false),
    sheetsSyncIntervalSeconds: integer("GOOGLE_SHEETS_SYNC_INTERVAL_SECONDS", 60, { min: 15, max: 3_600 }),
  };
}
