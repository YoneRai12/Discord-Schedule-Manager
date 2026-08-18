import "dotenv/config";
import path from "node:path";
import { Events } from "discord.js";
import { loadConfig } from "./config.mjs";
import { MeetingCoordinator } from "./coordinator.mjs";
import { CodexAppServerProvider } from "./ai/codex-app-server-provider.mjs";
import { MeetingDatabase } from "./database.mjs";
import { createDiscordClient } from "./discord-client.mjs";
import { DiscordDirectMessenger } from "./discord-direct-messenger.mjs";
import { DirectInviteUpdateScheduler } from "./direct-invite-update-scheduler.mjs";
import { MeetingCardUpdateScheduler } from "./meeting-card-update-scheduler.mjs";
import { buildDirectInvitePayload, buildPersonalReminderPayload } from "./discord-ui.mjs";
import { MeetingInterpreter } from "./interpreter.mjs";
import { meetingMessageText } from "./message-routing.mjs";
import { PersonalReminderScheduler } from "./personal-reminder-scheduler.mjs";
import { MeetingScheduler } from "./scheduler.mjs";
import { GoogleSheetsSync } from "./sheets-sync.mjs";
import { MeetingWebSync } from "./web-sync.mjs";
import { DiscordVoiceReceiver } from "./voice/discord-voice-receiver.mjs";
import { LocalTranscriber } from "./voice/local-transcriber.mjs";
import { ScheduledVoiceMeetingStarter } from "./voice/scheduled-voice-meeting-starter.mjs";
import { VoiceMeetingController } from "./voice/voice-meeting-controller.mjs";
import { VoiceMinutesAnalyzer } from "./voice/voice-minutes-analyzer.mjs";
import { VoiceSessionArchive } from "./voice/voice-session-archive.mjs";
import { VoiceSummaryPublisher } from "./voice/voice-summary-publisher.mjs";
import {
  initializeOptionalSheets,
  stopSchedulerAndDrain,
} from "../scripts/runtime-support.mjs";

const config = loadConfig();
const client = createDiscordClient();
const store = new MeetingDatabase(config.databasePath);
const codexProvider = (config.meetingAiProvider === "codex_app_server" || config.meetingVoiceAiSummaryEnabled)
  ? new CodexAppServerProvider({
    command: config.codexAppServerCommand,
    model: config.codexMeetingModel,
    reasoningEffort: config.codexReasoningEffort,
    timeoutMs: config.codexAppServerTimeoutMs,
  })
  : null;
const interpreter = new MeetingInterpreter({
  apiKey: config.meetingAiProvider === "openai" ? config.openaiApiKey : "",
  provider: codexProvider,
  model: codexProvider ? config.codexMeetingModel : config.openaiModel,
  reasoningEffort: codexProvider ? config.codexReasoningEffort : config.openaiReasoningEffort,
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
const directInviteUpdateScheduler = new DirectInviteUpdateScheduler({
  store,
  directMessenger,
  intervalSeconds: config.schedulerIntervalSeconds,
});
const meetingCardUpdateScheduler = new MeetingCardUpdateScheduler({
  store,
  client,
  attendeeMentionOffsets: config.attendeeMentionOffsets,
  intervalSeconds: config.schedulerIntervalSeconds,
});
const voiceArchive = config.meetingVoiceEnabled
  ? new VoiceSessionArchive({
    rootDir: config.meetingVoiceArchiveRoot,
    encryptionKey: config.meetingVoiceArchiveKey,
    retentionMs: config.meetingVoiceRetentionHours * 60 * 60_000,
    logger: console,
  })
  : null;
const voiceReceiver = voiceArchive ? new DiscordVoiceReceiver({ archive: voiceArchive }) : null;
const voiceTranscriber = voiceArchive
  ? new LocalTranscriber({
    archive: voiceArchive,
    pythonCommand: config.meetingVoicePythonCommand,
    scriptPath: path.join(config.projectRoot, "scripts", "transcribe_voice_session.py"),
    model: config.meetingVoiceSttModel,
    device: config.meetingVoiceSttDevice,
  })
  : null;
const voiceAnalyzer = config.meetingVoiceEnabled && config.meetingVoiceAiSummaryEnabled
  ? new VoiceMinutesAnalyzer({
    provider: codexProvider,
    summaryEnabled: true,
    factCheckEnabled: config.meetingVoiceFactCheckEnabled,
  })
  : null;
const voicePublisher = config.meetingVoiceEnabled
  ? new VoiceSummaryPublisher({
    client,
    guildId: config.guildId,
    outputChannelId: config.meetingVoiceOutputChannelId,
  })
  : null;
let coordinator;
const voiceMeetingController = config.meetingVoiceEnabled
  ? new VoiceMeetingController({
    client,
    guildId: config.guildId,
    outputChannelId: config.meetingVoiceOutputChannelId,
    archive: voiceArchive,
    receiver: voiceReceiver,
    transcriber: voiceTranscriber,
    analyzer: voiceAnalyzer,
    publisher: voicePublisher,
    enabled: true,
    summaryEnabled: config.meetingVoiceAiSummaryEnabled,
    factCheckEnabled: config.meetingVoiceFactCheckEnabled,
    maxSessionMinutes: config.meetingVoiceMaxSessionMinutes,
    noticeIntervalMinutes: config.meetingVoiceNoticeIntervalMinutes,
    maxParticipants: config.meetingVoiceMaxParticipants,
    canManage: (subject) => coordinator?.canManage(subject) === true,
    validateAutomaticSession: ({ sourceMeetingId, voiceChannelId, sessionId, nowMs }) => (
      store.isVoiceAutoSessionCurrent(sourceMeetingId, sessionId, {
        voiceChannelId,
        nowMs,
        earlyMinutes: config.meetingVoiceAutoStartEarlyMinutes,
      })
    ),
    releaseAutomaticSession: ({ sourceMeetingId, voiceChannelId, sessionId }) => (
      store.releaseVoiceAutoStart(sourceMeetingId, sessionId, {
        expectedVoiceChannelId: voiceChannelId,
      })
    ),
  })
  : null;
const scheduledVoiceMeetingStarter = voiceMeetingController
  ? new ScheduledVoiceMeetingStarter({
    client,
    store,
    controller: voiceMeetingController,
    guildId: config.guildId,
    earlyMinutes: config.meetingVoiceAutoStartEarlyMinutes,
    intervalSeconds: config.meetingVoiceAutoStartPollSeconds,
  })
  : null;
coordinator = new MeetingCoordinator({
  client,
  store,
  interpreter,
  sheetsSync,
  config,
  directMessenger,
  directInviteUpdateScheduler,
  meetingCardUpdateScheduler,
  voiceMeetingController,
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
let sheetsEnabled = false;
let shutdownPromise = null;

client.once(Events.ClientReady, async (readyClient) => {
  try {
    const guild = await readyClient.guilds.fetch(config.guildId);
    store.bindTenant({ guildId: guild.id, botUserId: readyClient.user.id });
    await coordinator.registerCommands();
    await voiceMeetingController?.initialize();
    await scheduledVoiceMeetingStarter?.start();
    const sheetsStartup = await initializeOptionalSheets({
      sheetsSync,
      intervalMs: config.sheetsSyncIntervalSeconds * 1_000,
    });
    sheetsEnabled = sheetsStartup.enabled;
    sheetsInterval = sheetsStartup.interval;
    scheduler.start();
    personalReminderScheduler.start();
    directInviteUpdateScheduler.start();
    meetingCardUpdateScheduler.start();
    webSync.start();
    console.log(`[ready] ${readyClient.user.tag} guild=${guild.id} sheets=${sheetsEnabled ? "on" : "off"} web=${webSync.configured ? "on" : "off"} ai=${interpreter.configured ? config.meetingAiProvider : "off"}`);
    if (codexProvider) {
      void interpreter.initialize().then(() => {
        console.log(`[ai] codex app-server ready model=${config.codexMeetingModel} effort=${config.codexReasoningEffort}`);
      }).catch((error) => {
        const code = String(error?.code || error?.name || "unknown").slice(0, 80);
        console.warn(`[ai] codex app-server unavailable code=${code}`);
      });
    }
    void coordinator.repairActiveInvitationUrls().then((urlRepair) => {
      if (urlRepair.repaired || urlRepair.failed || urlRepair.skippedByDeadline) {
        console.log(`[meeting-url] invitation repair repaired=${urlRepair.repaired} failed=${urlRepair.failed} skipped=${urlRepair.skippedByDeadline}`);
      }
    }).catch((error) => {
      const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
      console.warn(`[meeting-url] invitation repair aborted code=${code}`);
    });
  } catch (error) {
    const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
    console.error(`[startup] 初期化失敗 code=${code}`);
    await shutdown(1);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (voiceMeetingController) {
    try {
      const ended = await voiceMeetingController.handleMeetingEndMessage(message);
      if (ended) return;
      await voiceMeetingController.handleMessageCreate(message);
    } catch (error) {
      const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
      console.error(`[voice] VCチャット収録失敗 code=${code}`);
    }
  }
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
  const rawText = meetingMessageText({
    message,
    botUserId: client.user.id,
    configuredGuildId: config.guildId,
    store,
  });
  if (rawText == null) return;
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

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (!voiceMeetingController) return;
  void voiceMeetingController.handleVoiceStateUpdate(oldState, newState).then((handled) => (
    handled ? false : scheduledVoiceMeetingStarter?.handleVoiceStateUpdate(oldState, newState)
  )).catch((error) => {
    const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
    console.error(`[voice] state update failed code=${code}`);
  });
});

client.on(Events.Error, (error) => {
  const code = String(error?.code || error?.name || "unknown").slice(0, 80);
  console.error(`[discord] client error code=${code}`);
});

async function shutdown(exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (sheetsInterval) {
      clearInterval(sheetsInterval);
      sheetsInterval = null;
    }
    sheetsSync.close();
    webSync.close();
    scheduledVoiceMeetingStarter?.close();
    await Promise.all([
      stopSchedulerAndDrain(scheduler, { timeoutMs: 10_000, label: "meeting-scheduler" }),
      stopSchedulerAndDrain(personalReminderScheduler, { timeoutMs: 10_000, label: "personal-reminder-scheduler" }),
      stopSchedulerAndDrain(directInviteUpdateScheduler, { timeoutMs: 10_000, label: "direct-invite-update-scheduler" }),
      stopSchedulerAndDrain(meetingCardUpdateScheduler, { timeoutMs: 10_000, label: "meeting-card-update-scheduler" }),
    ]);
    await voiceMeetingController?.close?.();
    await codexProvider?.close?.();
    try {
      client.destroy();
    } finally {
      store.close();
    }
    process.exitCode = exitCode;
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.on("unhandledRejection", (error) => {
  const code = String(error?.code || error?.status || error?.name || "unknown").slice(0, 80);
  console.error(`[process] unhandled rejection code=${code}`);
});

await client.login(config.discordToken);
