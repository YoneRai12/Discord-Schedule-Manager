import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

const SAFE_ENV_NAMES = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "CUDA_PATH",
  "CUDA_VISIBLE_DEVICES",
  "HF_HOME",
];

export class LocalTranscriberError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "LocalTranscriberError";
    this.code = code;
  }
}

function safeEnvironment(source = process.env) {
  const env = Object.create(null);
  for (const name of SAFE_ENV_NAMES) {
    if (typeof source[name] === "string" && source[name]) env[name] = source[name];
  }
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  env.PYTHONUNBUFFERED = "1";
  env.HF_HUB_DISABLE_TELEMETRY = "1";
  env.DO_NOT_TRACK = "1";
  return env;
}

function text(value, label, maxLength = 4_096, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > maxLength || value.includes("\0")) {
    throw new LocalTranscriberError("INVALID_CONFIGURATION", `${label} is invalid`);
  }
  return value;
}

function validateTranscript(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.segments)) {
    throw new LocalTranscriberError("INVALID_OUTPUT", "local transcription returned an invalid JSON object");
  }
  const topKeys = Object.keys(value).sort();
  if (topKeys.length !== 2 || topKeys[0] !== "segments" || topKeys[1] !== "version") {
    throw new LocalTranscriberError("INVALID_OUTPUT", "local transcription returned unsupported fields");
  }
  if (value.segments.length > 100_000) {
    throw new LocalTranscriberError("INVALID_OUTPUT", "local transcription returned too many segments");
  }
  let previousStart = -Infinity;
  const result = { version: 1, segments: [] };
  for (const segment of value.segments) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      throw new LocalTranscriberError("INVALID_OUTPUT", "local transcription segment is invalid");
    }
    const keys = Object.keys(segment).sort();
    const allowed = ["endMs", "language", "speakerId", "speakerName", "startMs", "text"].sort();
    if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
      throw new LocalTranscriberError("INVALID_OUTPUT", "local transcription segment has unsupported fields");
    }
    const startMs = Number(segment.startMs);
    const endMs = Number(segment.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs || startMs < previousStart) {
      throw new LocalTranscriberError("INVALID_OUTPUT", "local transcription timestamps are invalid or unsorted");
    }
    const speakerId = text(segment.speakerId, "speakerId", 256);
    const speakerName = text(segment.speakerName, "speakerName", 512);
    const transcriptText = text(segment.text, "text", 100_000);
    const language = segment.language === null ? null : text(segment.language, "language", 32);
    previousStart = startMs;
    result.segments.push({ speakerId, speakerName, startMs, endMs, text: transcriptText, language });
  }
  return result;
}

function abortedError() {
  return new LocalTranscriberError("ABORTED", "local transcription was cancelled");
}

export class LocalTranscriber {
  #archive;
  #pythonCommand;
  #scriptPath;
  #model;
  #device;
  #timeoutMs;
  #maxOutputBytes;
  #logger;
  #spawn;
  #queue = Promise.resolve();

  constructor({
    archive,
    pythonCommand,
    scriptPath,
    model,
    device = "auto",
    timeoutMs = 30 * 60 * 1_000,
    maxOutputBytes = 16 * 1024 * 1024,
    logger = undefined,
    spawnImpl = nodeSpawn,
  } = {}) {
    if (!archive
      || typeof archive.materializeTranscriptionInput !== "function"
      || typeof archive.cleanupTranscriptionInput !== "function"
      || typeof archive.writeTranscript !== "function") {
      throw new LocalTranscriberError("INVALID_CONFIGURATION", "archive does not provide the local transcription contract");
    }
    if (typeof spawnImpl !== "function") throw new LocalTranscriberError("INVALID_CONFIGURATION", "spawnImpl is invalid");
    this.#archive = archive;
    this.#pythonCommand = text(String(pythonCommand ?? "").trim(), "pythonCommand", 1_024, { allowEmpty: false });
    this.#scriptPath = path.resolve(text(String(scriptPath ?? "").trim(), "scriptPath", 4_096, { allowEmpty: false }));
    this.#model = text(String(model ?? "").trim(), "model", 4_096, { allowEmpty: false });
    this.#device = text(String(device ?? "auto").trim().toLowerCase(), "device", 32);
    if (!new Set(["auto", "cuda", "cpu"]).has(this.#device)) {
      throw new LocalTranscriberError("INVALID_CONFIGURATION", "device must be auto, cuda, or cpu");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 24 * 60 * 60 * 1_000) {
      throw new LocalTranscriberError("INVALID_CONFIGURATION", "timeoutMs is outside the supported range");
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > 64 * 1024 * 1024) {
      throw new LocalTranscriberError("INVALID_CONFIGURATION", "maxOutputBytes is outside the supported range");
    }
    this.#timeoutMs = timeoutMs;
    this.#maxOutputBytes = maxOutputBytes;
    this.#logger = logger;
    this.#spawn = spawnImpl;
  }

  transcribeSession(sessionId, { signal = undefined } = {}) {
    const id = String(sessionId ?? "");
    if (signal != null && typeof signal.aborted !== "boolean") {
      throw new LocalTranscriberError("INVALID_CONFIGURATION", "signal is invalid");
    }
    const job = this.#queue.then(() => this.#run(id, signal), () => this.#run(id, signal));
    this.#queue = job.catch(() => {});
    return job;
  }

  async #run(sessionId, signal) {
    let workspace;
    let result;
    let runError;
    try {
      if (signal?.aborted) throw abortedError();
      workspace = await this.#archive.materializeTranscriptionInput(sessionId);
      if (signal?.aborted) throw abortedError();
      const stdout = await this.#spawnWorker(workspace.manifestPath, signal);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        throw new LocalTranscriberError("INVALID_OUTPUT", "local transcription returned malformed JSON", { cause: error });
      }
      result = validateTranscript(parsed);
      if (signal?.aborted) throw abortedError();
      await this.#archive.writeTranscript(sessionId, result);
    } catch (error) {
      runError = error;
    } finally {
      if (workspace) {
        try {
          await this.#archive.cleanupTranscriptionInput(workspace.workspaceId);
        } catch (error) {
          this.#logger?.error?.("local transcription cleanup failed", { failureCode: "TRANSCRIPTION_CLEANUP_FAILED" });
          runError = new LocalTranscriberError(
            "TRANSCRIPTION_CLEANUP_FAILED",
            "temporary decrypted transcription input could not be deleted",
            { cause: error },
          );
        }
      }
    }
    if (runError) throw runError;
    return result;
  }

  #spawnWorker(manifestPath, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortedError());
        return;
      }
      let child;
      try {
        child = this.#spawn(this.#pythonCommand, [
          this.#scriptPath,
          "--manifest",
          manifestPath,
          "--model",
          this.#model,
          "--device",
          this.#device,
        ], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: safeEnvironment(),
        });
      } catch (error) {
        reject(new LocalTranscriberError("SPAWN_FAILED", "local transcription worker could not be started", { cause: error }));
        return;
      }

      const chunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalError = null;
      let settled = false;
      const failAndKill = (error) => {
        if (!terminalError) terminalError = error;
        child.kill?.("SIGKILL");
      };
      const onAbort = () => failAndKill(abortedError());
      signal?.addEventListener?.("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        failAndKill(new LocalTranscriberError("TIMEOUT", "local transcription exceeded its time limit"));
      }, this.#timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (chunk) => {
        const data = Buffer.from(chunk);
        stdoutBytes += data.length;
        if (stdoutBytes > this.#maxOutputBytes) {
          failAndKill(new LocalTranscriberError("OUTPUT_LIMIT", "local transcription output exceeded its size limit"));
          return;
        }
        chunks.push(data);
      });
      child.stderr?.on("data", (chunk) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > this.#maxOutputBytes) {
          failAndKill(new LocalTranscriberError("OUTPUT_LIMIT", "local transcription diagnostic output exceeded its size limit"));
        }
      });
      child.once("error", (error) => {
        terminalError ||= new LocalTranscriberError("SPAWN_FAILED", "local transcription worker failed to start", { cause: error });
      });
      child.once("close", (code, terminationSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        if (terminalError) {
          reject(terminalError);
          return;
        }
        if (code !== 0) {
          reject(new LocalTranscriberError("WORKER_FAILED", "local transcription worker exited unsuccessfully"));
          return;
        }
        if (terminationSignal) {
          reject(new LocalTranscriberError("WORKER_FAILED", "local transcription worker was terminated"));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
  }
}

export { safeEnvironment as buildLocalTranscriberEnvironment, validateTranscript };
