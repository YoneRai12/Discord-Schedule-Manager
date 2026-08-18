import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAppServerProvider, safeChildEnvironment } from "../src/ai/codex-app-server-provider.mjs";

function temporaryProviderPaths(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-provider-test-"));
  const sourceHome = path.join(root, "source-codex-home");
  const sandboxDir = path.join(root, "sandbox");
  fs.mkdirSync(sourceHome, { recursive: true });
  fs.writeFileSync(path.join(sourceHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "dummy-id-token",
      access_token: "dummy-access-token",
      refresh_token: "dummy-refresh-token",
      account_id: "dummy-account",
    },
  }), "utf8");
  fs.writeFileSync(path.join(sourceHome, "models_cache.json"), JSON.stringify({
    fetched_at: "2026-07-20T00:00:00.000Z",
    etag: "test-etag",
    client_version: "test-version",
    models: [
      {
        slug: "gpt-5.3-codex-spark",
        description: "test model",
        include_apps_usage_instructions: true,
        include_plugin_usage_instructions: true,
        include_skills_usage_instructions: true,
        node_repl_auto_review_required: true,
        node_repl_disabled: false,
      },
      { slug: "unrelated-model", description: "must not be copied" },
    ],
  }), "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sourceHome, sandboxDir };
}

function fakeAppServer({ completeTurn = true, responseText = '{"action":"unknown"}', stallMethod = null, turnError = null } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedByProvider = false;
  child.kill = () => {
    child.killedByProvider = true;
    return true;
  };
  const messages = [];
  let pending = "";
  const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    while (pending.includes("\n")) {
      const index = pending.indexOf("\n");
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      if (message.method === stallMethod) continue;
      if (message.method === "initialize") {
        send({ id: message.id, result: { userAgent: "test" } });
      } else if (message.method === "model/list") {
        send({ id: message.id, result: {
          data: [{
            slug: "gpt-5.3-codex-spark",
            supported_reasoning_levels: ["medium"],
          }],
          nextCursor: null,
        } });
      } else if (message.method === "thread/start") {
        send({ id: message.id, result: { thread: { id: "thread-test" } } });
      } else if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: "turn-test" } } });
        if (turnError) {
          queueMicrotask(() => send({ method: "error", params: {
            threadId: "thread-test",
            turnId: "turn-test",
            willRetry: false,
            error: turnError,
          } }));
          continue;
        }
        if (!completeTurn) continue;
        queueMicrotask(() => {
          send({ method: "item/completed", params: {
            threadId: "thread-test",
            turnId: "turn-test",
            item: { id: "message-test", type: "agentMessage", text: responseText },
          } });
          send({ method: "turn/completed", params: {
            threadId: "thread-test",
            turn: { id: "turn-test", status: "completed" },
          } });
        });
      } else if (message.method === "thread/delete") {
        send({ id: message.id, result: {} });
      }
    }
  });
  return { child, messages };
}

test("Codex App Serverをstdio・一時thread・read-only・承認なしで呼び出す", async (t) => {
  const paths = temporaryProviderPaths(t);
  fs.writeFileSync(path.join(paths.sourceHome, "config.toml"), "[mcp_servers.private]\n", "utf8");
  for (const directory of ["plugins", "skills", "memories"]) {
    fs.mkdirSync(path.join(paths.sourceHome, directory));
  }
  const fake = fakeAppServer();
  let spawnCall = null;
  const provider = new CodexAppServerProvider({
    spawnImpl: (command, args, options) => {
      spawnCall = { command, args, options };
      return fake.child;
    },
    environment: {
      PATH: "safe-path",
      USERPROFILE: paths.root,
      CODEX_HOME: paths.sourceHome,
      DISCORD_BOT_TOKEN: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      GOOGLE_PRIVATE_KEY: "must-not-leak",
    },
    sandboxDir: paths.sandboxDir,
    logger: { warn() {}, error() {} },
  });
  t.after(() => provider.close());

  const result = await provider.generateStructured({
    systemPrompt: "会議入力を分類してください。",
    userPayload: { messageText: "来週月曜の全体MTG", hasMeetingUrl: true },
    outputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
  });

  assert.equal(result, '{"action":"unknown"}');
  assert.deepEqual(spawnCall.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(spawnCall.options.windowsHide, true);
  assert.equal(spawnCall.options.env.DISCORD_BOT_TOKEN, undefined);
  assert.equal(spawnCall.options.env.OPENAI_API_KEY, undefined);
  assert.notEqual(spawnCall.options.env.CODEX_HOME, paths.sourceHome);
  assert.equal(spawnCall.options.env.HOME, spawnCall.options.env.CODEX_HOME);
  assert.equal(spawnCall.options.env.USERPROFILE, spawnCall.options.env.CODEX_HOME);
  assert.equal(path.dirname(spawnCall.options.env.CODEX_HOME), paths.sandboxDir);
  assert.equal(path.dirname(spawnCall.options.cwd), paths.sandboxDir);
  assert.notEqual(spawnCall.options.cwd, spawnCall.options.env.CODEX_HOME);
  assert.ok(path.relative(spawnCall.options.cwd, spawnCall.options.env.CODEX_HOME).startsWith(".."));
  assert.deepEqual(fs.readdirSync(spawnCall.options.cwd), [
    ".discord-meeting-ai-owner.json",
  ]);
  assert.deepEqual(fs.readdirSync(spawnCall.options.env.CODEX_HOME).sort(), [
    ".discord-meeting-ai-owner.json",
    "auth.json",
    "config.toml",
    "model_catalog.json",
  ]);
  for (const directory of [spawnCall.options.cwd, spawnCall.options.env.CODEX_HOME]) {
    const marker = JSON.parse(fs.readFileSync(path.join(directory, ".discord-meeting-ai-owner.json"), "utf8"));
    assert.equal(marker.schemaVersion, 2);
    assert.ok(Number.isSafeInteger(marker.ownerProcessStartedAtMs));
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(spawnCall.options.env.CODEX_HOME, "auth.json"), "utf8")),
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "dummy-id-token",
        access_token: "dummy-access-token",
        refresh_token: "dummy-refresh-token",
        account_id: "dummy-account",
      },
    },
  );
  const isolatedCatalog = JSON.parse(
    fs.readFileSync(path.join(spawnCall.options.env.CODEX_HOME, "model_catalog.json"), "utf8"),
  );
  assert.deepEqual(isolatedCatalog.models.map((item) => item.slug), ["gpt-5.3-codex-spark"]);
  assert.equal(isolatedCatalog.models[0].supports_reasoning_summaries, false);
  assert.equal(Object.hasOwn(isolatedCatalog.models[0], "tool_mode"), false);
  assert.equal(Object.hasOwn(isolatedCatalog.models[0], "multi_agent_version"), false);
  assert.equal(Object.hasOwn(isolatedCatalog.models[0], "supports_reasoning_summary_parameter"), false);
  assert.equal(isolatedCatalog.models[0].include_apps_usage_instructions, false);
  assert.equal(isolatedCatalog.models[0].include_plugin_usage_instructions, false);
  assert.equal(isolatedCatalog.models[0].include_skills_usage_instructions, false);
  assert.equal(Object.hasOwn(isolatedCatalog.models[0], "node_repl_auto_review_required"), false);
  assert.equal(Object.hasOwn(isolatedCatalog.models[0], "node_repl_disabled"), false);
  const isolatedConfig = fs.readFileSync(path.join(spawnCall.options.env.CODEX_HOME, "config.toml"), "utf8");
  assert.match(isolatedConfig, /^model_catalog_json = /mu);
  assert.match(isolatedConfig, /^cli_auth_credentials_store = "file"$/mu);
  assert.doesNotMatch(isolatedConfig, /mcp|plugin|skill|hook/iu);
  const thread = fake.messages.find((message) => message.method === "thread/start");
  assert.equal(thread.params.model, "gpt-5.3-codex-spark");
  assert.equal(thread.params.cwd, spawnCall.options.cwd);
  assert.equal(thread.params.ephemeral, true);
  assert.equal(thread.params.approvalPolicy, "never");
  assert.equal(thread.params.sandbox, "read-only");
  assert.equal(thread.params.config.web_search, "disabled");
  assert.equal(thread.params.config.features.shell_tool, false);
  assert.equal(thread.params.config.features.hooks, false);
  assert.equal(thread.params.config.features.apps, false);
  assert.deepEqual(thread.params.config.shell_environment_policy, { include_only: [] });
  const turn = fake.messages.find((message) => message.method === "turn/start");
  assert.equal(turn.params.effort, "medium");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(turn.params.approvalPolicy, "never");
  assert.ok(turn.params.outputSchema);
  assert.equal(Object.hasOwn(turn.params, "maxOutputTokens"), false);
  assert.equal(Object.hasOwn(turn.params, "max_output_tokens"), false);
});

test("Codex子プロセスへBot・Sheets・OpenAIの秘密環境変数を継承しない", () => {
  const env = safeChildEnvironment({
    PATH: "safe",
    TEMP: "C:\\Temp",
    CODEX_HOME: "X:\\Profile\\.codex",
    DISCORD_BOT_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    GOOGLE_SERVICE_ACCOUNT_FILE: "secret.json",
    MEETING_WEB_SYNC_SECRET: "secret",
  });
  assert.deepEqual(env, {
    PATH: "safe",
    TEMP: "C:\\Temp",
  });
});

test("allowWebSearch=trueの要求だけweb_search liveとnetworkを許可し、他ツールは無効のまま", async (t) => {
  const paths = temporaryProviderPaths(t);
  const fake = fakeAppServer();
  const provider = new CodexAppServerProvider({
    environment: { PATH: "safe", USERPROFILE: paths.root, CODEX_HOME: paths.sourceHome },
    sandboxDir: paths.sandboxDir,
    spawnImpl: () => fake.child,
    logger: { warn() {}, error() {} },
  });
  t.after(() => provider.close());

  await provider.generateStructured({
    systemPrompt: "単一の公開claimを検証する",
    userPayload: { claim: "Node.js 24は2025年に公開された。" },
    outputSchema: { type: "object" },
    allowWebSearch: true,
  });

  const thread = fake.messages.find((message) => message.method === "thread/start");
  const turn = fake.messages.find((message) => message.method === "turn/start");
  assert.equal(thread.params.config.web_search, "live");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: true });
  assert.deepEqual(thread.params.config.mcp_servers, {});
  assert.equal(thread.params.config.features.apps, false);
  assert.equal(thread.params.config.features.remote_plugin, false);
  assert.equal(thread.params.config.features.shell_tool, false);
  assert.equal(thread.params.config.features.unified_exec, false);
  assert.match(thread.params.baseInstructions, /ウェブ検索以外のツール/u);
});

test("Codex turn失敗の診断は安全な型と状態だけを残し本文を保持しない", async (t) => {
  const paths = temporaryProviderPaths(t);
  const fake = fakeAppServer({
    turnError: {
      message: "https://private.example.invalid <@1234567890>",
      additionalDetails: "private meeting text",
      reason: "private meeting title must not survive",
      codexErrorInfo: {
        responseStreamDisconnected: { httpStatusCode: 429 },
      },
    },
  });
  const provider = new CodexAppServerProvider({
    environment: { PATH: "safe", USERPROFILE: paths.root, CODEX_HOME: paths.sourceHome },
    sandboxDir: paths.sandboxDir,
    spawnImpl: () => fake.child,
  });
  t.after(() => provider.close());

  await assert.rejects(
    provider.generateStructured({
      systemPrompt: "meeting parser",
      userPayload: { messageText: "private meeting text", hasMeetingUrl: true },
      outputSchema: { type: "object" },
    }),
    (error) => error.code === "responseStreamDisconnected",
  );
  assert.deepEqual(provider.lastTurnDiagnostics, {
    code: "responseStreamDisconnected",
    willRetry: false,
    error: { type: "responseStreamDisconnected", httpStatusCode: 429 },
  });
  const diagnostics = JSON.stringify(provider.lastTurnDiagnostics);
  assert.doesNotMatch(diagnostics, /private|1234567890|https:/u);
});

test("Codexモデルcacheに未確認フィールドが増えても一時カタログへコピーしない", async (t) => {
  const paths = temporaryProviderPaths(t);
  const cachePath = path.join(paths.sourceHome, "models_cache.json");
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  cache.models[0].unexpected_private_field = "must-not-copy";
  fs.writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  let spawnCalls = 0;
  const provider = new CodexAppServerProvider({
    environment: { PATH: "safe", USERPROFILE: paths.root, CODEX_HOME: paths.sourceHome },
    sandboxDir: paths.sandboxDir,
    spawnImpl: () => {
      spawnCalls += 1;
      return fakeAppServer().child;
    },
  });
  t.after(() => provider.close());

  await provider.initialize();
  assert.equal(spawnCalls, 1);
  const isolatedCatalog = JSON.parse(
    fs.readFileSync(path.join(provider.isolatedCodexHome, "model_catalog.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(isolatedCatalog.models[0], "unexpected_private_field"), false);
});

test("Codexモデルcacheの利用指示フラグがboolean以外なら安全側で起動しない", async (t) => {
  const paths = temporaryProviderPaths(t);
  const cachePath = path.join(paths.sourceHome, "models_cache.json");
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  cache.models[0].include_apps_usage_instructions = "true";
  fs.writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  const provider = new CodexAppServerProvider({
    environment: { PATH: "safe", USERPROFILE: paths.root, CODEX_HOME: paths.sourceHome },
    sandboxDir: paths.sandboxDir,
    spawnImpl: () => fakeAppServer().child,
  });
  t.after(() => provider.close());

  await assert.rejects(
    provider.initialize(),
    (error) => error.code === "model_catalog_schema_changed",
  );
});

test("turnタイムアウト後は子プロセスを破棄し次回呼び出しで再初期化する", async (t) => {
  const paths = temporaryProviderPaths(t);
  const stalled = fakeAppServer({ completeTurn: false });
  const recovered = fakeAppServer();
  const children = [stalled.child, recovered.child];
  let spawnCalls = 0;
  const provider = new CodexAppServerProvider({
    environment: { PATH: "safe", USERPROFILE: paths.root, CODEX_HOME: paths.sourceHome },
    sandboxDir: paths.sandboxDir,
    timeoutMs: 25,
    spawnImpl: () => {
      const child = children[spawnCalls];
      spawnCalls += 1;
      return child;
    },
  });
  t.after(() => provider.close());
  const request = {
    systemPrompt: "会議入力を分類してください。",
    userPayload: { messageText: "会議", hasMeetingUrl: true },
    outputSchema: { type: "object" },
  };

  await assert.rejects(provider.generateStructured(request), (error) => error.code === "timeout");
  assert.equal(stalled.child.killedByProvider, true);
  assert.equal(stalled.child.stdout.destroyed, true);
  assert.equal(stalled.child.stderr.destroyed, true);
  assert.equal(provider.process, null);
  assert.equal(await provider.generateStructured(request), '{"action":"unknown"}');
  assert.equal(spawnCalls, 2);
});

test("RPCタイムアウト後も子プロセスを破棄し次回呼び出しで再初期化する", async (t) => {
  const paths = temporaryProviderPaths(t);
  const stalled = fakeAppServer({ stallMethod: "thread/start" });
  const recovered = fakeAppServer();
  const children = [stalled.child, recovered.child];
  let spawnCalls = 0;
  const provider = new CodexAppServerProvider({
    environment: { PATH: "safe", USERPROFILE: paths.root, CODEX_HOME: paths.sourceHome },
    sandboxDir: paths.sandboxDir,
    timeoutMs: 25,
    spawnImpl: () => {
      const child = children[spawnCalls];
      spawnCalls += 1;
      return child;
    },
  });
  t.after(() => provider.close());
  const request = {
    systemPrompt: "会議入力を分類してください。",
    userPayload: { messageText: "会議", hasMeetingUrl: true },
    outputSchema: { type: "object" },
  };

  await assert.rejects(provider.generateStructured(request), (error) => error.code === "timeout");
  assert.equal(stalled.child.killedByProvider, true);
  assert.equal(await provider.generateStructured(request), '{"action":"unknown"}');
  assert.equal(spawnCalls, 2);
});

test("Codexの構造化結果がローカル上限を超えたら破棄する", async (t) => {
  const paths = temporaryProviderPaths(t);
  const fake = fakeAppServer({ responseText: "x".repeat(128) });
  const provider = new CodexAppServerProvider({
    environment: { PATH: "safe", USERPROFILE: paths.root, CODEX_HOME: paths.sourceHome },
    sandboxDir: paths.sandboxDir,
    maxOutputBytes: 32,
    spawnImpl: () => fake.child,
  });
  t.after(() => provider.close());

  await assert.rejects(
    provider.generateStructured({
      systemPrompt: "会議入力を分類してください。",
      userPayload: { messageText: "会議", hasMeetingUrl: true },
      outputSchema: { type: "object" },
      maxOutputTokens: 1,
    }),
    (error) => error.code === "output_too_large",
  );
  assert.equal(fake.child.killedByProvider, true);
});

test("起動時は所有markerがあり停止中の自領域だけを回収する", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-provider-stale-test-"));
  const sandboxDir = path.join(root, "sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true });
  const markerName = ".discord-meeting-ai-owner.json";
  const makeOwned = (name, kind, ownerPid) => {
    const target = path.join(sandboxDir, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, markerName), JSON.stringify({
      schemaVersion: 1,
      owner: "discord-meeting-manager-bot.codex-app-server",
      kind,
      ownerPid,
      instanceId: `test-${name}`,
      createdAtMs: Date.now() - 60_000,
    }));
    return target;
  };
  const staleHome = makeOwned("codex-home-stale", "codex-home", 111);
  fs.writeFileSync(path.join(staleHome, "auth.json"), "secret");
  const staleWorkspace = makeOwned("workspace-stale", "workspace", 111);
  const activeHome = makeOwned("codex-home-active", "codex-home", 222);
  const unownedHome = path.join(sandboxDir, "codex-home-unowned");
  const unrelated = path.join(sandboxDir, "other-directory");
  fs.mkdirSync(unownedHome);
  fs.mkdirSync(unrelated);

  const provider = new CodexAppServerProvider({
    sandboxDir,
    isProcessAlive: (pid) => pid === 222,
  });
  const result = provider.recoverStaleOwnedDirectories();

  assert.deepEqual(result, {
    removed: 2,
    skippedActive: 1,
    skippedUnowned: 1,
    failed: 0,
  });
  assert.equal(fs.existsSync(staleHome), false);
  assert.equal(fs.existsSync(staleWorkspace), false);
  assert.equal(fs.existsSync(activeHome), true);
  assert.equal(fs.existsSync(unownedHome), true);
  assert.equal(fs.existsSync(unrelated), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("PIDが再利用された所有markerは回収し、同じプロセス実体の領域は保持する", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-provider-pid-reuse-test-"));
  const sandboxDir = path.join(root, "sandbox");
  fs.mkdirSync(sandboxDir, { recursive: true });
  const markerName = ".discord-meeting-ai-owner.json";
  const makeOwned = (name, ownerPid, ownerProcessStartedAtMs) => {
    const target = path.join(sandboxDir, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, markerName), JSON.stringify({
      schemaVersion: 2,
      owner: "discord-meeting-manager-bot.codex-app-server",
      kind: "codex-home",
      ownerPid,
      ownerProcessStartedAtMs,
      instanceId: `test-${name}`,
      createdAtMs: Date.now() - 60_000,
    }));
    return target;
  };
  const reusedPidHome = makeOwned("codex-home-reused-pid", 444, 1_000);
  fs.writeFileSync(path.join(reusedPidHome, "auth.json"), "");
  const activeHome = makeOwned("codex-home-active-instance", 555, 3_000);

  const provider = new CodexAppServerProvider({
    sandboxDir,
    isProcessAlive: (pid) => pid === 444 || pid === 555,
    processStartedAtMs: (pid) => ({ 444: 2_000, 555: 3_000 })[pid] ?? null,
  });
  const result = provider.recoverStaleOwnedDirectories();

  assert.deepEqual(result, {
    removed: 1,
    skippedActive: 1,
    skippedUnowned: 0,
    failed: 0,
  });
  assert.equal(fs.existsSync(reusedPidHome), false);
  assert.equal(fs.existsSync(activeHome), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("closeはauth.jsonを最優先で削除し一時領域の削除完了を待てる", async (t) => {
  const paths = temporaryProviderPaths(t);
  const fake = fakeAppServer();
  const removals = [];
  let firstAuthRemoval = true;
  const provider = new CodexAppServerProvider({
    environment: { PATH: "safe", USERPROFILE: paths.root, CODEX_HOME: paths.sourceHome },
    sandboxDir: paths.sandboxDir,
    spawnImpl: () => fake.child,
    cleanupRetryDelayMs: 1,
    removePath: (target, options) => {
      removals.push(target);
      if (target.endsWith(`${path.sep}auth.json`) && firstAuthRemoval) {
        firstAuthRemoval = false;
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      }
      fs.rmSync(target, options);
    },
  });
  await provider.initialize();
  const isolatedHome = provider.isolatedCodexHome;
  const workspaceDir = provider.workspaceDir;

  const closeResult = provider.close();
  assert.equal(typeof closeResult?.then, "function");
  await closeResult;

  const firstAuth = removals.findIndex((target) => target.endsWith(`${path.sep}auth.json`));
  const firstHome = removals.findIndex((target) => target === isolatedHome);
  assert.ok(firstAuth >= 0);
  assert.ok(firstHome > firstAuth);
  assert.equal(fs.existsSync(isolatedHome), false);
  assert.equal(fs.existsSync(workspaceDir), false);
});
