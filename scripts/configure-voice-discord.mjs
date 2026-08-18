import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ChannelType,
  PermissionFlagsBits,
  REST,
  Routes,
} from "discord.js";
import { loadConfig } from "../src/config.mjs";

const ROLE_NAME = "VC議事録閲覧";
const CHANNEL_NAME = "会議議事録";

function snowflake(value, label) {
  const text = String(value || "");
  if (!/^\d{16,20}$/u.test(text)) throw new Error(`${label}_invalid`);
  return text;
}

function registeredMemberIds(databasePath, guildId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`
      SELECT DISTINCT user_id
      FROM (
        SELECT user_id FROM member_aliases WHERE guild_id = ?
        UNION
        SELECT user_id FROM attendance_template_members WHERE guild_id = ?
      )
      ORDER BY user_id
    `).all(guildId, guildId).map((row) => snowflake(row.user_id, "registered_user"));
  } finally {
    database.close();
  }
}

async function updateEnv(projectRoot, values) {
  const envPath = path.join(projectRoot, ".env");
  const original = await readFile(envPath, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/u);
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (index >= 0) lines[index] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  const temporary = `${envPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, lines.join(eol), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, envPath);
}

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.discordToken);
const bot = await rest.get(Routes.user());
const botId = snowflake(bot.id, "bot_user");
const guildId = snowflake(config.guildId, "guild");

const roles = await rest.get(Routes.guildRoles(guildId));
let reviewRole = roles.find((role) => role.name === ROLE_NAME && !role.managed);
if (!reviewRole) {
  reviewRole = await rest.post(Routes.guildRoles(guildId), {
    body: { name: ROLE_NAME, mentionable: false, hoist: false, reason: "VC議事録の限定閲覧" },
  });
}
const roleId = snowflake(reviewRole.id, "review_role");

const channels = await rest.get(Routes.guildChannels(guildId));
let outputChannel = channels.find((channel) => channel.type === ChannelType.GuildText && channel.name === CHANNEL_NAME);
const botAllow = PermissionFlagsBits.ViewChannel
  | PermissionFlagsBits.SendMessages
  | PermissionFlagsBits.AttachFiles
  | PermissionFlagsBits.EmbedLinks
  | PermissionFlagsBits.ReadMessageHistory;
const reviewerAllow = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;

if (!outputChannel) {
  outputChannel = await rest.post(Routes.guildChannels(guildId), {
    body: {
      name: CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: "同意制VC文字起こしの未確認議事録。ローカルバックアップは開始から24時間で削除されます。",
      permission_overwrites: [
        { id: guildId, type: 0, allow: "0", deny: String(PermissionFlagsBits.ViewChannel) },
        { id: roleId, type: 0, allow: String(reviewerAllow), deny: "0" },
        { id: botId, type: 1, allow: String(botAllow), deny: "0" },
      ],
      reason: "VC議事録専用の非公開チャンネル",
    },
  });
} else {
  const channelId = snowflake(outputChannel.id, "output_channel");
  await rest.put(Routes.channelPermission(channelId, guildId), {
    body: { type: 0, allow: "0", deny: String(PermissionFlagsBits.ViewChannel) },
  });
  await rest.put(Routes.channelPermission(channelId, roleId), {
    body: { type: 0, allow: String(reviewerAllow), deny: "0" },
  });
  await rest.put(Routes.channelPermission(channelId, botId), {
    body: { type: 1, allow: String(botAllow), deny: "0" },
  });
}

const members = registeredMemberIds(config.databasePath, guildId);
for (const memberId of members) {
  await rest.put(Routes.guildMemberRole(guildId, memberId, roleId));
}

const archiveKey = config.meetingVoiceArchiveKey || randomBytes(32).toString("base64");
await updateEnv(config.projectRoot, {
  MEETING_VOICE_ENABLED: "true",
  MEETING_VOICE_OUTPUT_CHANNEL_ID: snowflake(outputChannel.id, "output_channel"),
  MEETING_VOICE_RETENTION_HOURS: "24",
  MEETING_VOICE_ARCHIVE_DIR: "voice-sessions",
  MEETING_VOICE_ARCHIVE_KEY: archiveKey,
  MEETING_VOICE_PYTHON_COMMAND: ".voice-venv/Scripts/python.exe",
  MEETING_VOICE_STT_MODEL: "data/models/faster-whisper-large-v3",
  MEETING_VOICE_STT_DEVICE: "cuda",
  MEETING_VOICE_AI_SUMMARY_ENABLED: "true",
  MEETING_VOICE_FACT_CHECK_ENABLED: "true",
});

console.log(JSON.stringify({
  ok: true,
  channelCreated: !channels.some((channel) => channel.id === outputChannel.id),
  roleCreated: !roles.some((role) => role.id === reviewRole.id),
  registeredMembersGranted: members.length,
}));
