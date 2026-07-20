import { execFileSync } from "node:child_process";
import { CodexAppServerProvider, safeChildEnvironment } from "../src/ai/codex-app-server-provider.mjs";
import { MeetingInterpreter } from "../src/interpreter.mjs";

const provider = new CodexAppServerProvider({
  command: process.env.CODEX_APP_SERVER_COMMAND || "codex",
  model: process.env.CODEX_MEETING_MODEL || "gpt-5.3-codex-spark",
  reasoningEffort: process.env.CODEX_REASONING_EFFORT || "medium",
  timeoutMs: 90_000,
});

const interpreter = new MeetingInterpreter({
  provider,
  model: process.env.CODEX_MEETING_MODEL || "gpt-5.3-codex-spark",
  reasoningEffort: process.env.CODEX_REASONING_EFFORT || "medium",
  timeZone: "Asia/Tokyo",
  defaultReminderMinutes: [30, 0],
});

try {
  try {
    await provider.initialize();
  } catch (error) {
    console.error(JSON.stringify({
      code: String(error?.code || error?.name || "unknown"),
      modelList: provider.lastModelDiagnostics,
    }));
    throw error;
  }
  const isolatedEnvironment = {
    ...safeChildEnvironment(process.env),
    CODEX_HOME: provider.isolatedCodexHome,
    HOME: provider.isolatedCodexHome,
    USERPROFILE: provider.isolatedCodexHome,
  };
  const mcpOutput = execFileSync(provider.command, ["mcp", "list", "--json"], {
    cwd: provider.workspaceDir,
    env: isolatedEnvironment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const mcpResult = JSON.parse(mcpOutput);
  const configuredMcpServers = Array.isArray(mcpResult)
    ? mcpResult
    : (mcpResult.servers || mcpResult.data);
  if (!Array.isArray(configuredMcpServers) || configuredMcpServers.length !== 0) {
    throw new Error("codex_mcp_isolation_failed");
  }

  let parsed;
  try {
    parsed = await interpreter.interpret({
      sanitizedText: "[MEMBER_ALIAS] 2026年7月27日20時 全体会議 [URL_REDACTED]",
      hasMeetingUrl: true,
      nowMs: Date.parse("2026-07-20T00:00:00.000Z"),
    });
  } catch (error) {
    console.error(JSON.stringify({
      code: String(error?.code || error?.name || "unknown"),
      turn: provider.lastTurnDiagnostics,
    }));
    throw error;
  }
  if (parsed.action !== "create" || parsed.title !== "全体会議" || parsed.startsAtMs == null) {
    throw new Error("unexpected_interpretation");
  }
  console.log(`codex_app_server_smoke=ok action=${parsed.action} missing=${parsed.missingFields.length} mcp=0`);
} finally {
  interpreter.close();
}
