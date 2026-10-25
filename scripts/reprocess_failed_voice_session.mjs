import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { CodexAppServerProvider } from "../src/ai/codex-app-server-provider.mjs";
import { createDiscordClient } from "../src/discord-client.mjs";
import { LocalTranscriber } from "../src/voice/local-transcriber.mjs";
import { VoiceMeetingController } from "../src/voice/voice-meeting-controller.mjs";
import { VoiceMinutesAnalyzer } from "../src/voice/voice-minutes-analyzer.mjs";
import { VoiceSessionArchive } from "../src/voice/voice-session-archive.mjs";
import { VoiceSummaryPublisher } from "../src/voice/voice-summary-publisher.mjs";

const SESSION_ID_RE = /^[A-F0-9]{10}$/u;

function errorCode(error) {
  const code = String(error?.code || error?.status || error?.name || "VOICE_REPROCESS_FAILED").toUpperCase();
  return /^[A-Z0-9_:-]{1,80}$/u.test(code) ? code : "VOICE_REPROCESS_FAILED";
}

async function latestSessionId(archiveRoot, states, nowMs = Date.now()) {
  const raw = await readFile(path.join(archiveRoot, "index.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) {
    throw new Error("voice archive index is invalid");
  }
  const eligible = parsed.sessions
    .filter((entry) => (
      states.includes(entry?.state)
      && SESSION_ID_RE.test(String(entry?.sessionId || ""))
      && Date.parse(entry?.expiresAt) > nowMs
    ))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  if (!eligible.length) throw new Error("再処理できるセッションがありません");
  return eligible[0].sessionId;
}

async function main() {
  const config = loadConfig();
  if (!config.meetingVoiceEnabled) throw new Error("VC文字起こし機能が無効です");

  const reuseTranscript = process.argv.includes("--reuse-transcript");
  const suppliedId = String(process.argv.slice(2).find((argument) => !argument.startsWith("--")) || "")
    .trim()
    .toUpperCase();
  if (suppliedId && !SESSION_ID_RE.test(suppliedId)) {
    throw new Error("セッションIDの形式が正しくありません");
  }
  const targetSessionId = suppliedId || await latestSessionId(
    config.meetingVoiceArchiveRoot,
    reuseTranscript ? ["review_pending", "analysis_failed"] : ["processing_failed"],
  );

  const client = createDiscordClient();
  const archive = new VoiceSessionArchive({
    rootDir: config.meetingVoiceArchiveRoot,
    encryptionKey: config.meetingVoiceArchiveKey,
    retentionMs: config.meetingVoiceRetentionHours * 60 * 60_000,
  });
  const provider = config.meetingVoiceAiSummaryEnabled
    ? new CodexAppServerProvider({
      command: config.codexAppServerCommand,
      model: config.codexMeetingModel,
      reasoningEffort: config.codexReasoningEffort,
      timeoutMs: config.codexAppServerTimeoutMs,
    })
    : null;
  const transcriber = new LocalTranscriber({
    archive,
    pythonCommand: config.meetingVoicePythonCommand,
    scriptPath: path.join(config.projectRoot, "scripts", "transcribe_voice_session.py"),
    model: config.meetingVoiceSttModel,
    device: config.meetingVoiceSttDevice,
  });
  const analyzer = provider
    ? new VoiceMinutesAnalyzer({
      provider,
      summaryEnabled: true,
      factCheckEnabled: config.meetingVoiceFactCheckEnabled,
    })
    : null;
  const publisher = new VoiceSummaryPublisher({
    client,
    guildId: config.guildId,
    outputChannelId: config.meetingVoiceOutputChannelId,
  });
  const controller = new VoiceMeetingController({
    client,
    guildId: config.guildId,
    outputChannelId: config.meetingVoiceOutputChannelId,
    archive,
    receiver: { stop: async () => ({ stopped: false }) },
    transcriber,
    analyzer,
    publisher,
    enabled: true,
    summaryEnabled: config.meetingVoiceAiSummaryEnabled,
    factCheckEnabled: config.meetingVoiceFactCheckEnabled,
  });

  try {
    await archive.initialize();
    await client.login(config.discordToken);
    await client.guilds.fetch(config.guildId);
    console.log(reuseTranscript ? "[voice-reanalyze] started" : "[voice-reprocess] started");
    let outcome;
    if (reuseTranscript) {
      outcome = await controller.reanalyze(targetSessionId);
    } else {
      const started = await controller.reprocess(targetSessionId);
      const task = started.task || controller.processing.get(started.sessionId);
      if (!task) throw new Error("voice reprocess task was not registered");
      outcome = await task;
    }
    if (outcome?.ok !== true) {
      throw Object.assign(new Error("voice reprocess failed"), { code: outcome?.code || "voice_reprocess_failed" });
    }
    console.log(`${reuseTranscript ? "[voice-reanalyze]" : "[voice-reprocess]"} completed ai=${outcome.aiUsed === true ? "on" : "off"}`);
  } finally {
    await controller.close().catch(() => {});
    await provider?.close?.().catch(() => {});
    client.destroy();
  }
}

main().catch((error) => {
  console.error(`[voice-reprocess] failed code=${errorCode(error)}`);
  process.exitCode = 1;
});

export { latestSessionId };
