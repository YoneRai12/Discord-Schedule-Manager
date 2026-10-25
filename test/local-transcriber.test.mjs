import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  LocalTranscriber,
  buildLocalTranscriberEnvironment,
  validateTranscript,
} from "../src/voice/local-transcriber.mjs";

function childThat({ stdout = "", stderr = "", code = 0, closeDelayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  let timer;
  child.kill = (signal) => {
    child.killCalls.push(signal);
    clearTimeout(timer);
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  timer = setTimeout(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, null);
  }, closeDelayMs);
  return child;
}

function archiveStub() {
  return {
    materialized: [],
    cleaned: [],
    written: [],
    async materializeTranscriptionInput(sessionId) {
      this.materialized.push(sessionId);
      return {
        workspaceId: `work_${sessionId}`,
        manifestPath: `C:\\safe\\${sessionId}\\manifest.json`,
      };
    },
    async cleanupTranscriptionInput(workspaceId) {
      this.cleaned.push(workspaceId);
    },
    async writeTranscript(sessionId, value) {
      this.written.push({ sessionId, value });
    },
  };
}

const validOutput = JSON.stringify({
  version: 1,
  segments: [{
    speakerId: "123",
    speakerName: "private name",
    startMs: 10,
    endMs: 20,
    text: "private transcript",
    language: "ja",
  }],
});

test("spawns one fixed local Python worker with shell disabled and a scrubbed environment", async () => {
  const archive = archiveStub();
  const calls = [];
  const transcriber = new LocalTranscriber({
    archive,
    pythonCommand: "C:\\Python\\python.exe",
    scriptPath: "C:\\bot\\scripts\\transcribe_voice_session.py",
    model: "C:\\models\\whisper",
    device: "cuda",
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return childThat({ stdout: validOutput });
    },
  });
  const result = await transcriber.transcribeSession("session1");
  assert.deepEqual(result, JSON.parse(validOutput));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "C:\\Python\\python.exe");
  assert.deepEqual(calls[0].args.slice(1), [
    "--manifest",
    "C:\\safe\\session1\\manifest.json",
    "--model",
    "C:\\models\\whisper",
    "--device",
    "cuda",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[0].options.env.DISCORD_BOT_TOKEN, undefined);
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(calls[0].options.env.HF_HUB_DISABLE_TELEMETRY, "1");
  assert.deepEqual(archive.cleaned, ["work_session1"]);
  assert.equal(archive.written.length, 1);
});

test("queue concurrency is one through cleanup", async () => {
  const archive = archiveStub();
  let active = 0;
  let maximum = 0;
  archive.materializeTranscriptionInput = async function materialize(sessionId) {
    active += 1;
    maximum = Math.max(maximum, active);
    this.materialized.push(sessionId);
    return { workspaceId: `work_${sessionId}`, manifestPath: `C:\\safe\\${sessionId}\\manifest.json` };
  };
  archive.cleanupTranscriptionInput = async function cleanup(workspaceId) {
    this.cleaned.push(workspaceId);
    active -= 1;
  };
  const transcriber = new LocalTranscriber({
    archive,
    pythonCommand: "python",
    scriptPath: "worker.py",
    model: "local-model",
    spawnImpl: () => childThat({ stdout: validOutput, closeDelayMs: 5 }),
  });
  await Promise.all([transcriber.transcribeSession("one"), transcriber.transcribeSession("two")]);
  assert.equal(maximum, 1);
  assert.deepEqual(archive.materialized, ["one", "two"]);
});

test("timeout kills the worker, rejects safely, and still cleans decrypted files", async () => {
  const archive = archiveStub();
  let child;
  const transcriber = new LocalTranscriber({
    archive,
    pythonCommand: "python",
    scriptPath: "worker.py",
    model: "local-model",
    timeoutMs: 20,
    spawnImpl: () => {
      child = childThat({ stdout: validOutput, closeDelayMs: 10_000 });
      return child;
    },
  });
  await assert.rejects(transcriber.transcribeSession("timeout"), (error) => error?.code === "TIMEOUT");
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
  assert.deepEqual(archive.cleaned, ["work_timeout"]);
});

test("oversized or malformed output and unsorted timestamps are rejected", async () => {
  const archive = archiveStub();
  const oversized = new LocalTranscriber({
    archive,
    pythonCommand: "python",
    scriptPath: "worker.py",
    model: "local-model",
    maxOutputBytes: 1_024,
    spawnImpl: () => childThat({ stdout: "x".repeat(1_025) }),
  });
  await assert.rejects(oversized.transcribeSession("large"), (error) => error?.code === "OUTPUT_LIMIT");
  assert.deepEqual(archive.cleaned, ["work_large"]);

  assert.throws(() => validateTranscript({ version: 1, segments: [{
    speakerId: "1", speakerName: "name", startMs: 2, endMs: 3, text: "a", language: "ja",
  }, {
    speakerId: "2", speakerName: "name", startMs: 1, endMs: 3, text: "b", language: "ja",
  }] }), (error) => error?.code === "INVALID_OUTPUT");
});

test("safe environment has no unrelated process secrets", () => {
  const env = buildLocalTranscriberEnvironment({
    PATH: "safe-path",
    TEMP: "safe-temp",
    DISCORD_BOT_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    HOME: "private-home",
  });
  assert.equal(env.PATH, "safe-path");
  assert.equal(env.TEMP, "safe-temp");
  assert.equal(env.DISCORD_BOT_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HOME, undefined);
});

test("auto device is accepted and passed to the offline worker", async () => {
  const archive = archiveStub();
  let args;
  const transcriber = new LocalTranscriber({
    archive,
    pythonCommand: "python",
    scriptPath: "worker.py",
    model: "local-model",
    device: "auto",
    spawnImpl: (_command, workerArgs) => {
      args = workerArgs;
      return childThat({ stdout: validOutput });
    },
  });
  await transcriber.transcribeSession("auto-session");
  assert.deepEqual(args.slice(-2), ["--device", "auto"]);
});

test("decrypted workspace cleanup failure overrides success and is reported fail-closed", async () => {
  const archive = archiveStub();
  archive.cleanupTranscriptionInput = async () => {
    throw new Error("sensitive local detail");
  };
  const logs = [];
  const transcriber = new LocalTranscriber({
    archive,
    pythonCommand: "python",
    scriptPath: "worker.py",
    model: "local-model",
    logger: { error: (...args) => logs.push(args) },
    spawnImpl: () => childThat({ stdout: validOutput }),
  });
  await assert.rejects(
    transcriber.transcribeSession("cleanup"),
    (error) => error?.code === "TRANSCRIPTION_CLEANUP_FAILED",
  );
  assert.equal(JSON.stringify(logs).includes("sensitive local detail"), false);
});

test("abort kills the active worker and waits for decrypted workspace cleanup", async () => {
  const archive = archiveStub();
  const abortController = new AbortController();
  let child;
  const transcriber = new LocalTranscriber({
    archive,
    pythonCommand: "python",
    scriptPath: "worker.py",
    model: "local-model",
    spawnImpl: () => {
      child = childThat({ stdout: validOutput, closeDelayMs: 10_000 });
      return child;
    },
  });
  const task = transcriber.transcribeSession("cancelled", { signal: abortController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abortController.abort("deleted");

  await assert.rejects(task, (error) => error?.code === "ABORTED");
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
  assert.deepEqual(archive.cleaned, ["work_cancelled"]);
});

test("queued job aborted before start never materializes decrypted audio", async () => {
  const archive = archiveStub();
  const abortController = new AbortController();
  let spawnCount = 0;
  const transcriber = new LocalTranscriber({
    archive,
    pythonCommand: "python",
    scriptPath: "worker.py",
    model: "local-model",
    spawnImpl: () => {
      spawnCount += 1;
      return childThat({ stdout: validOutput, closeDelayMs: 10 });
    },
  });
  const first = transcriber.transcribeSession("first");
  const second = transcriber.transcribeSession("never-materialized", { signal: abortController.signal });
  abortController.abort("deleted");

  await first;
  await assert.rejects(second, (error) => error?.code === "ABORTED");
  assert.deepEqual(archive.materialized, ["first"]);
  assert.equal(spawnCount, 1);
});
