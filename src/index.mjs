import "dotenv/config";
import { Events } from "discord.js";
import { loadConfig } from "./config.mjs";
import { MeetingCoordinator } from "./coordinator.mjs";
import { MeetingDatabase } from "./database.mjs";
import { createDiscordClient } from "./discord-client.mjs";
import { DiscordDirectMessenger } from "./discord-direct-messenger.mjs";
import { buildDirectInvitePayload, buildPersonalReminderPayload } from "./discord-ui.mjs";
import { MeetingInterpreter } from "./interpreter.mjs";
import { PersonalReminderScheduler } from "./personal-reminder-scheduler.mjs";
import { MeetingScheduler } from "./scheduler.mjs";
import { GoogleSheetsSync } from "./sheets-sync.mjs";
import { MeetingWebSync } from "./web-sync.mjs";

const config = loadConfig();
const client = createDiscordClient();
const store = new MeetingDatabase(config.databasePath);
const interpreter = new MeetingInterpreter({
  apiKey: config.openaiApiKey,
  model: config.openaiModel,
  reasoningEffort: config.openaiReasoningEffort,
  maxOutputTokens: config.openaiMaxOutputTokens,
  timeZone: config.timeZone,
  defaultDurationMinutes: config.defaultDurationMinutes,
  defaultReminderMinutes: config.defaultReminders,
});
const sheetsSync = new GoogleSheetsSync({
  spreadsheetId: config.spreadsheetId,
  keyFile: config.googleServiceAccountFile,
  syncUrls: config.syncMeetingUrlsToSheets,
  store,
});
const directMessenger = new DiscordDirectMessenger({
  client,
  guildId: config.guildId,
  buildInvitePayload: (meeting, { recipient }) => buildDirectInvitePayload(meeting, {
    personalReminderMinutes: recipient.personalReminderMinutes,
  }),
  buildReminderPayload: buildPersonalReminderPayload,
});
const coordinator = new MeetingCoordinator({
  client,
  store,
  interpreter,
  sheetsSync,
  config,
  directMessenger,
});
const scheduler = new MeetingScheduler({
  client,
  store,
  sheetsSync,
  intervalSeconds: config.schedulerIntervalSeconds,
  maxLateMinutes: config.maxLateMinutes,
});
const personalReminderScheduler = new PersonalReminderScheduler({
  store,
  directMessenger,
  intervalSeconds: config.schedulerIntervalSeconds,
  maxLateMinutes: config.maxLateMinutes,
});
const webSync = new MeetingWebSync({
  url: config.webSyncUrl,
  secret: config.webSyncSecret,
  authToken: config.webAuthToken,
  intervalSeconds: config.webSyncIntervalSeconds,
  timeoutMs: config.webSyncTimeoutMs,
  maxRetries: config.webSyncMaxRetries,
  store,
});
let sheetsInterval = null;
let shuttingDown = false;

client.once(Events.ClientReady, async (readyClient) => {
  try {
    const guild = await readyClient.guilds.fetch(config.guildId);
    store.bindTenant({ guildId: guild.id, botUserId: readyClient.user.id });
    await coordinator.registerCommands();
    if (sheetsSync.configured) {
      await sheetsSync.initialize();
      await sheetsSync.sync();
      sheetsInterval = setInterval(() => void sheetsSync.sync().catch((error) => {
        const code = String(error?.code || error?.status || "unknown").slice(0, 80);
        console.error(`[sheets] 定期同期失敗 code=${code}`);
      }), config.sheetsSyncIntervalSeconds * 1_000);
      sheetsInterval.unref?.();
    }
    scheduler.start();
    personalReminderScheduler.start();
    webSync.start();
    console.log(`[ready] ${readyClient.user.tag} guild=${guild.id} sheets=${sheetsSync.configured ? "on" : "off"} web=${webSync.configured ? "on" : "off"} ai=${interpreter.configured ? "on" : "off"}`);
  } catch (error) {
    const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
    console.error(`[startup] 初期化失敗 code=${code}`);
    await shutdown(1);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !client.user) return;
  if (message.guildId == null) {
    try {
      await coordinator.handleDirectMessage(message);
    } catch (error) {
      const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
      console.error(`[dm] 回答処理失敗 code=${code}`);
      await message.reply({ content: "出欠回答を処理できませんでした。時間をおいてもう一度お試しください。", allowedMentions: { parse: [] } }).catch(() => {});
    }
    return;
  }
  if (message.guildId !== config.guildId) return;
  if (!message.mentions.has(client.user)) return;
  const mentionPattern = new RegExp(`<@!?${client.user.id}>`, "gu");
  const rawText = message.content.replace(mentionPattern, " ").trim();
  try {
    await coordinator.handleMention(message, rawText);
  } catch (error) {
    const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
    console.error(`[mention] 応答処理失敗 code=${code}`);
    await message.reply({
      content: "処理中にエラーが発生しました。内容を短くして、もう一度試してください。",
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await coordinator.handleInteraction(interaction);
  } catch (error) {
    const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
    console.error(`[interaction] 未処理エラー code=${code}`);
    const payload = { content: "処理中にエラーが発生しました。", flags: 64 };
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  }
});

client.on(Events.Error, (error) => {
  const code = String(error?.code || error?.name || "unknown").slice(0, 80);
  console.error(`[discord] client error code=${code}`);
});

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();
  personalReminderScheduler.stop();
  webSync.close();
  sheetsSync.close();
  if (sheetsInterval) clearInterval(sheetsInterval);
  try {
    client.destroy();
  } finally {
    store.close();
  }
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.on("unhandledRejection", (error) => {
  const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
  console.error(`[process] unhandled rejection code=${code}`);
});

await client.login(config.discordToken);
