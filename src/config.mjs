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

function choice(name, fallback, allowedValues) {
  const value = String(process.env[name] || fallback).trim().toLowerCase();
  if (!allowedValues.includes(value)) {
    throw new Error(`${name} は ${allowedValues.join(", ")} のいずれかで指定してください`);
  }
  return value;
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

function snowflake(name) {
  const value = String(process.env[name] ?? "").trim();
  if (value && !/^\d{16,20}$/.test(value)) {
    throw new Error(`${name} にはDiscordのIDを指定してください`);
  }
  return value;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function loadConfig({ requireSecrets = true } = {}) {
  const defaultReminders = parseIntegerList(process.env.MEETING_DEFAULT_REMINDERS_MINUTES || "30,0");
  const personalDefaultReminders = parseIntegerList(
    process.env.MEETING_PERSONAL_DEFAULT_REMINDERS_MINUTES || "60,10",
    { min: 0, max: 10_080, maxItems: 6 },
  );
  const attendeeMentionOffsets = parseIntegerList(
    process.env.MEETING_ATTENDEE_MENTION_OFFSETS_MINUTES
      || process.env.MEETING_EVERYONE_OFFSETS_MINUTES
      || "0",
  );
  const dataDir = path.resolve(PROJECT_ROOT, process.env.MEETING_DATA_DIR || "data");
  const serviceAccountFile = String(process.env.GOOGLE_SERVICE_ACCOUNT_FILE ?? "").trim();
  const meetingVoiceEnabled = boolean("MEETING_VOICE_ENABLED", false);
  const meetingVoiceRetentionHours = integer("MEETING_VOICE_RETENTION_HOURS", 24, { min: 24, max: 24 });
  const meetingVoiceArchiveRoot = path.resolve(
    dataDir,
    String(process.env.MEETING_VOICE_ARCHIVE_DIR || "voice-sessions").trim(),
  );
  const meetingVoiceArchiveKey = String(process.env.MEETING_VOICE_ARCHIVE_KEY ?? "").trim();
  const meetingVoiceOutputChannelId = snowflake("MEETING_VOICE_OUTPUT_CHANNEL_ID");
  if (!isPathInside(dataDir, meetingVoiceArchiveRoot)) {
    throw new Error("MEETING_VOICE_ARCHIVE_DIR はMEETING_DATA_DIRの中にしてください");
  }
  if (meetingVoiceEnabled && !meetingVoiceOutputChannelId) {
    throw new Error("MEETING_VOICE_OUTPUT_CHANNEL_ID が設定されていません");
  }
  if (meetingVoiceEnabled) {
    let key;
    try {
      key = Buffer.from(meetingVoiceArchiveKey, "base64");
    } catch {
      key = null;
    }
    if (!key || key.length !== 32 || key.toString("base64") !== meetingVoiceArchiveKey) {
      throw new Error("MEETING_VOICE_ARCHIVE_KEY は32バイトのBase64鍵にしてください");
    }
  }
  const meetingVoiceAiSummaryEnabled = boolean("MEETING_VOICE_AI_SUMMARY_ENABLED", false);
  const meetingVoiceFactCheckEnabled = boolean("MEETING_VOICE_FACT_CHECK_ENABLED", false);
  if (meetingVoiceFactCheckEnabled && !meetingVoiceAiSummaryEnabled) {
    throw new Error("MEETING_VOICE_FACT_CHECK_ENABLED にはMEETING_VOICE_AI_SUMMARY_ENABLED=trueが必要です");
  }
  const meetingAiProvider = choice("MEETING_AI_PROVIDER", "openai", ["openai", "codex_app_server"]);
  if (meetingVoiceAiSummaryEnabled && meetingAiProvider !== "codex_app_server") {
    throw new Error("VC要約を有効にする場合はMEETING_AI_PROVIDER=codex_app_serverにしてください");
  }

  return {
    projectRoot: PROJECT_ROOT,
    discordToken: requireSecrets ? required("DISCORD_BOT_TOKEN") : String(process.env.DISCORD_BOT_TOKEN ?? "").trim(),
    guildId: requireSecrets ? required("DISCORD_GUILD_ID") : String(process.env.DISCORD_GUILD_ID ?? "").trim(),
    creatorRoleIds: snowflakeList("MEETING_CREATOR_ROLE_IDS"),
    timeZone: "Asia/Tokyo",
    defaultDurationMinutes: integer("MEETING_DEFAULT_DURATION_MINUTES", 60, { min: 5, max: 1_440 }),
    defaultReminders,
    personalDefaultReminders,
    attendeeMentionOffsets,
    schedulerIntervalSeconds: integer("MEETING_SCHEDULER_INTERVAL_SECONDS", 15, { min: 5, max: 300 }),
    maxLateMinutes: integer("MEETING_MAX_LATE_MINUTES", 10, { min: 0, max: 1_440 }),
    dataDir,
    databasePath: path.join(dataDir, "meetings.sqlite3"),
    meetingAiProvider,
    openaiApiKey: String(process.env.OPENAI_API_KEY ?? "").trim(),
    openaiModel: String(process.env.OPENAI_MEETING_MODEL || "gpt-5.6-terra").trim(),
    openaiReasoningEffort: choice(
      "OPENAI_REASONING_EFFORT",
      "medium",
      ["none", "low", "medium", "high", "xhigh", "max"],
    ),
    openaiMaxOutputTokens: integer("OPENAI_MAX_OUTPUT_TOKENS", 1_200, { min: 200, max: 8_000 }),
    codexAppServerCommand: String(process.env.CODEX_APP_SERVER_COMMAND || "codex").trim(),
    codexMeetingModel: String(process.env.CODEX_MEETING_MODEL || "gpt-5.3-codex-spark").trim(),
    codexReasoningEffort: choice(
      "CODEX_REASONING_EFFORT",
      "medium",
      ["low", "medium", "high", "xhigh"],
    ),
    codexAppServerTimeoutMs: integer("CODEX_APP_SERVER_TIMEOUT_MS", 60_000, { min: 5_000, max: 180_000 }),
    spreadsheetId: String(process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? "").trim(),
    googleServiceAccountFile: serviceAccountFile ? path.resolve(PROJECT_ROOT, serviceAccountFile) : "",
    syncMeetingUrlsToSheets: boolean("GOOGLE_SHEETS_SYNC_URLS", false),
    sheetsSyncIntervalSeconds: integer("GOOGLE_SHEETS_SYNC_INTERVAL_SECONDS", 60, { min: 15, max: 3_600 }),
    webSyncUrl: String(process.env.MEETING_WEB_SYNC_URL ?? "").trim(),
    webSyncSecret: String(process.env.MEETING_WEB_SYNC_SECRET ?? "").trim(),
    webAuthToken: String(process.env.MEETING_WEB_AUTH_TOKEN ?? "").trim(),
    webSyncIntervalSeconds: integer("MEETING_WEB_SYNC_INTERVAL_SECONDS", 60, { min: 15, max: 3_600 }),
    webSyncTimeoutMs: integer("MEETING_WEB_SYNC_TIMEOUT_MS", 8_000, { min: 250, max: 60_000 }),
    webSyncMaxRetries: integer("MEETING_WEB_SYNC_MAX_RETRIES", 2, { min: 0, max: 5 }),
    meetingVoiceEnabled,
    meetingVoiceOutputChannelId,
    meetingVoiceRetentionHours,
    meetingVoiceArchiveRoot,
    meetingVoiceArchiveKey,
    meetingVoiceMaxSessionMinutes: integer("MEETING_VOICE_MAX_SESSION_MINUTES", 240, { min: 5, max: 480 }),
    meetingVoiceNoticeIntervalMinutes: integer("MEETING_VOICE_NOTICE_INTERVAL_MINUTES", 30, { min: 5, max: 60 }),
    meetingVoiceMaxParticipants: integer("MEETING_VOICE_MAX_PARTICIPANTS", 20, { min: 1, max: 25 }),
    meetingVoicePythonCommand: String(process.env.MEETING_VOICE_PYTHON_COMMAND || "python").trim(),
    meetingVoiceSttModel: String(process.env.MEETING_VOICE_STT_MODEL || "large-v3").trim(),
    meetingVoiceSttDevice: choice("MEETING_VOICE_STT_DEVICE", "auto", ["auto", "cuda", "cpu"]),
    meetingVoiceAiSummaryEnabled,
    meetingVoiceFactCheckEnabled,
  };
}
