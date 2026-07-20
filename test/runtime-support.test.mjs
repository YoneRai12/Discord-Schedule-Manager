import assert from "node:assert/strict";
import test from "node:test";
import {
  initializeOptionalSheets,
  stopSchedulerAndDrain,
} from "../scripts/runtime-support.mjs";

test("Sheets初期化失敗はDiscord起動を止めず同期を無効化する", async () => {
  const warnings = [];
  let closed = 0;
  let intervalCalls = 0;
  const sheetsSync = {
    configured: true,
    api: { shouldBeCleared: true },
    async initialize() { throw Object.assign(new Error("private details"), { code: "ENOENT" }); },
    async sync() { throw new Error("must not run"); },
    close() { closed += 1; },
  };

  const result = await initializeOptionalSheets({
    sheetsSync,
    intervalMs: 60_000,
    logger: { warn: (message) => warnings.push(message) },
    setIntervalImpl: () => { intervalCalls += 1; },
  });

  assert.deepEqual(result, { enabled: false, interval: null, errorCode: "ENOENT" });
  assert.equal(closed, 1);
  assert.equal(sheetsSync.api, null);
  assert.equal(intervalCalls, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Discord BOTは継続/u);
  assert.doesNotMatch(warnings[0], /private details/u);
});

test("Sheets初回sync失敗も無効化し、成功時だけ定期同期を始める", async () => {
  const firstSyncFailure = {
    configured: true,
    api: null,
    async initialize() { this.api = {}; },
    async sync() { throw Object.assign(new Error("quota detail"), { status: 403 }); },
    close() {},
  };
  const failed = await initializeOptionalSheets({
    sheetsSync: firstSyncFailure,
    intervalMs: 60_000,
    logger: { warn() {} },
  });
  assert.equal(failed.enabled, false);
  assert.equal(failed.errorCode, "403");
  assert.equal(firstSyncFailure.api, null);

  let syncCalls = 0;
  const intervalHandle = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const working = {
    configured: true,
    api: null,
    async initialize() { this.api = {}; },
    async sync() { syncCalls += 1; },
    close() {},
  };
  const ready = await initializeOptionalSheets({
    sheetsSync: working,
    intervalMs: 60_000,
    logger: { warn() {}, error() {} },
    setIntervalImpl: (callback, delay) => {
      assert.equal(typeof callback, "function");
      assert.equal(delay, 60_000);
      return intervalHandle;
    },
  });
  assert.equal(ready.enabled, true);
  assert.equal(ready.interval, intervalHandle);
  assert.equal(syncCalls, 1);
  assert.equal(intervalHandle.unrefCalled, true);
});

test("shutdownはstopAndDrainがあれば待ち、旧schedulerはstopへフォールバックする", async () => {
  const calls = [];
  await stopSchedulerAndDrain({
    async stopAndDrain(timeoutMs) {
      calls.push(["drain", timeoutMs]);
    },
  }, { timeoutMs: 4321, label: "group", logger: { warn() {} } });
  await stopSchedulerAndDrain({
    stop() { calls.push(["stop"]); },
  }, { timeoutMs: 4321, label: "personal", logger: { warn() {} } });
  assert.deepEqual(calls, [["drain", 4321], ["stop"]]);
});

test("stopAndDrain失敗時も安全な警告だけを残して終了処理を継続する", async () => {
  const warnings = [];
  const result = await stopSchedulerAndDrain({
    async stopAndDrain() {
      throw Object.assign(new Error("meeting title must not leak"), { code: "drain_timeout" });
    },
  }, { label: "group", logger: { warn: (message) => warnings.push(message) } });
  assert.equal(result, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /drain_timeout/u);
  assert.doesNotMatch(warnings[0], /meeting title/u);
});
