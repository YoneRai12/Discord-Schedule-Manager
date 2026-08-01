import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const RETENTION_MS = 24 * 60 * 60 * 1_000;
const INDEX_FILE = "index.json";
const ENCRYPTED_MAGIC = Buffer.from("VSA1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = ENCRYPTED_MAGIC.length + IV_BYTES + TAG_BYTES;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const PRIVATE_META_FIELDS = [
  "guildId",
  "voiceChannelId",
  "outputChannelId",
  "requestedById",
  "title",
  "consents",
  "noticeMessageId",
  "requiredUserIds",
  "consentedUserIds",
  "policyRevision",
  "startedAtMs",
  "stoppedAtMs",
  "completedAtMs",
  "stopReason",
  "stoppedById",
];

export class VoiceArchiveError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "VoiceArchiveError";
    this.code = code;
  }
}

function parseMasterKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new VoiceArchiveError("INVALID_KEY", "archive key must be exactly 32 bytes");
    return Buffer.from(value);
  }
  const encoded = String(value ?? "").trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) {
    throw new VoiceArchiveError("INVALID_KEY", "archive key must be canonical base64 for exactly 32 bytes");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new VoiceArchiveError("INVALID_KEY", "archive key must be canonical base64 for exactly 32 bytes");
  }
  return key;
}

function safeId(value, label) {
  const id = String(value ?? "");
  if (!SAFE_ID_RE.test(id)) {
    throw new VoiceArchiveError("UNSAFE_PATH", `${label} is not a safe archive identifier`);
  }
  return id;
}

function dateMs(value, label) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new VoiceArchiveError("INVALID_TIME", `${label} is invalid`);
  return milliseconds;
}

function exactIndexEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const keys = Object.keys(entry).sort();
  const allowed = ["createdAt", "expiresAt", "failureCode", "sessionId", "state"].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) return false;
  return SAFE_ID_RE.test(entry.sessionId)
    && typeof entry.state === "string"
    && Number.isFinite(Date.parse(entry.createdAt))
    && Number.isFinite(Date.parse(entry.expiresAt))
    && (entry.failureCode === null || typeof entry.failureCode === "string");
}

function cleanFailureCode(value) {
  if (value === null || value === undefined || value === "") return null;
  const code = String(value);
  if (!/^[A-Z0-9_:-]{1,96}$/u.test(code)) {
    throw new VoiceArchiveError("INVALID_FAILURE_CODE", "failureCode contains unsupported characters");
  }
  return code;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export class VoiceSessionArchive {
  #rootDir;
  #sessionsDir;
  #workDir;
  #key;
  #now;
  #logger;
  #index = new Map();
  #initialized = false;
  #closed = false;
  #operation = Promise.resolve();

  constructor({ rootDir, encryptionKey, retentionMs = RETENTION_MS, now = () => Date.now(), logger = undefined } = {}) {
    if (!rootDir || !path.isAbsolute(String(rootDir))) {
      throw new VoiceArchiveError("INVALID_ROOT", "rootDir must be an absolute path inside the configured data directory");
    }
    if (retentionMs !== RETENTION_MS) {
      throw new VoiceArchiveError("INVALID_RETENTION", "voice archive retention is fixed at 24 hours");
    }
    if (typeof now !== "function") throw new VoiceArchiveError("INVALID_CLOCK", "now must be a function");
    this.#rootDir = path.resolve(rootDir);
    this.#sessionsDir = path.join(this.#rootDir, "sessions");
    this.#workDir = path.join(this.#rootDir, ".work");
    this.#key = parseMasterKey(encryptionKey);
    this.#now = now;
    this.#logger = logger;
  }

  get rootDir() {
    return this.#rootDir;
  }

  async initialize() {
    return this.#serialize(async () => {
      if (this.#initialized) return;
      await mkdir(this.#rootDir, { recursive: true, mode: 0o700 });
      await this.#assertRootIsPhysicalDirectory();
      await mkdir(this.#sessionsDir, { mode: 0o700 }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await mkdir(this.#workDir, { mode: 0o700 }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await this.#assertSafeExistingPath(this.#sessionsDir, { directory: true });
      await this.#assertSafeExistingPath(this.#workDir, { directory: true });
      await this.#loadIndex();
      await this.#removeStaleParts();
      this.#initialized = true;
      await this.#purgeExpiredInternal();
    });
  }

  async createSession(meta = {}) {
    return this.#serialize(async () => {
      this.#assertReady();
      const sessionId = safeId(meta.sessionId ?? randomUUID().replaceAll("-", ""), "sessionId");
      if (this.#index.has(sessionId)) throw new VoiceArchiveError("SESSION_EXISTS", "voice session already exists");
      const createdMs = dateMs(this.#now(), "now");
      const createdAt = new Date(createdMs).toISOString();
      const expiresAt = new Date(createdMs + RETENTION_MS).toISOString();
      const sessionDir = this.#sessionDir(sessionId);
      await this.#assertSafeParent(sessionDir);
      await mkdir(path.join(sessionDir, "segments"), { recursive: true, mode: 0o700 });
      await this.#assertSafeExistingPath(sessionDir, { directory: true });
      const state = String(meta.state ?? "recording");
      if (!state || state.length > 96) throw new VoiceArchiveError("INVALID_STATE", "session state is invalid");
      const failureCode = cleanFailureCode(meta.failureCode);
      const privateMeta = {
        version: 1,
        sessionId,
        createdAt,
        expiresAt,
        createdAtMs: createdMs,
        expiresAtMs: createdMs + RETENTION_MS,
        state,
        failureCode,
        segments: [],
        consents: [],
      };
      for (const field of PRIVATE_META_FIELDS) {
        if (Object.hasOwn(meta, field)) privateMeta[field] = structuredClone(meta[field]);
      }
      await this.#writeEncryptedJson(this.#metadataPath(sessionId), privateMeta, this.#aad("metadata", sessionId));
      const indexEntry = { sessionId, state, createdAt, expiresAt, failureCode };
      this.#index.set(sessionId, indexEntry);
      try {
        await this.#persistIndex();
      } catch (error) {
        this.#index.delete(sessionId);
        await this.#deleteTreeSafe(sessionDir).catch(() => {});
        throw error;
      }
      return structuredClone({ ...privateMeta, ...indexEntry });
    });
  }

  async getSession(sessionId) {
    return this.#serialize(async () => {
      this.#assertReady();
      return this.#getSessionInternal(safeId(sessionId, "sessionId"));
    });
  }

  async updateSession(sessionId, patch = {}) {
    return this.#serialize(async () => {
      this.#assertReady();
      const id = safeId(sessionId, "sessionId");
      const current = await this.#getSessionInternal(id);
      if (!current) throw new VoiceArchiveError("SESSION_NOT_FOUND", "voice session was not found");
      for (const immutable of ["sessionId", "createdAt", "expiresAt", "createdAtMs", "expiresAtMs", "segments"]) {
        if (Object.hasOwn(patch, immutable)) {
          throw new VoiceArchiveError("IMMUTABLE_SESSION_FIELD", `${immutable} cannot be changed`);
        }
      }
      const next = { ...current };
      const recognized = new Set([...PRIVATE_META_FIELDS, "state", "failureCode", "consent"]);
      const unknown = Object.keys(patch).filter((field) => !recognized.has(field));
      if (unknown.length) {
        throw new VoiceArchiveError("UNSUPPORTED_SESSION_FIELD", "session patch contains an unsupported field");
      }
      for (const field of [...PRIVATE_META_FIELDS, "state", "failureCode"]) {
        if (Object.hasOwn(patch, field)) next[field] = structuredClone(patch[field]);
      }
      if (Object.hasOwn(patch, "consent")) {
        const history = Array.isArray(next.consents) ? next.consents : [];
        next.consents = [...history, structuredClone(patch.consent)].slice(-10_000);
      }
      next.state = String(next.state ?? "");
      if (!next.state || next.state.length > 96) throw new VoiceArchiveError("INVALID_STATE", "session state is invalid");
      next.failureCode = cleanFailureCode(next.failureCode);
      await this.#writePrivateSession(id, next);
      const indexEntry = this.#index.get(id);
      indexEntry.state = next.state;
      indexEntry.failureCode = next.failureCode;
      await this.#persistIndex();
      return structuredClone(next);
    });
  }

  async createSegment(sessionId, { speakerId, speakerName, startedAtMs } = {}) {
    return this.#serialize(async () => {
      this.#assertReady();
      const id = safeId(sessionId, "sessionId");
      const session = await this.#requireSession(id);
      const segmentId = randomUUID().replaceAll("-", "");
      const segment = {
        segmentId,
        speakerId: String(speakerId ?? ""),
        speakerName: String(speakerName ?? ""),
        startedAtMs: dateMs(startedAtMs, "startedAtMs"),
        endedAtMs: null,
        state: "recording",
      };
      const tempPath = this.#segmentPartPath(id, segmentId);
      await this.#assertSafeParent(tempPath);
      const handle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600);
      await handle.close();
      session.segments.push(segment);
      try {
        await this.#writePrivateSession(id, session);
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        throw error;
      }
      return { segmentId, tempPath };
    });
  }

  async finalizeSegment(sessionId, segmentId, { endedAtMs } = {}) {
    return this.#serialize(async () => {
      this.#assertReady();
      const id = safeId(sessionId, "sessionId");
      const sid = safeId(segmentId, "segmentId");
      const session = await this.#requireSession(id);
      const segment = session.segments.find((item) => item.segmentId === sid);
      if (!segment) throw new VoiceArchiveError("SEGMENT_NOT_FOUND", "voice segment was not found");
      if (segment.state !== "recording") throw new VoiceArchiveError("SEGMENT_FINALIZED", "voice segment is not recording");
      const partPath = this.#segmentPartPath(id, sid);
      const encryptedPath = this.#segmentEncryptedPath(id, sid);
      await this.#assertSafeExistingPath(partPath, { file: true });
      const end = dateMs(endedAtMs, "endedAtMs");
      if (end < segment.startedAtMs) throw new VoiceArchiveError("INVALID_TIME", "segment end precedes its start");
      await this.#encryptFile(partPath, encryptedPath, this.#aad("segment", id, sid));
      try {
        await unlink(partPath);
      } catch (error) {
        await unlink(encryptedPath).catch(() => {});
        throw new VoiceArchiveError("PLAINTEXT_DELETE_FAILED", "plaintext segment could not be removed", { cause: error });
      }
      segment.endedAtMs = end;
      segment.state = "finalized";
      try {
        await this.#writePrivateSession(id, session);
      } catch (error) {
        throw new VoiceArchiveError("METADATA_WRITE_FAILED", "finalized segment metadata could not be persisted", { cause: error });
      }
      return structuredClone(segment);
    });
  }

  async discardSegment(sessionId, segmentId) {
    return this.#serialize(async () => {
      this.#assertReady();
      const id = safeId(sessionId, "sessionId");
      const sid = safeId(segmentId, "segmentId");
      const session = await this.#requireSession(id);
      const index = session.segments.findIndex((item) => item.segmentId === sid);
      if (index < 0) return false;
      for (const candidate of [this.#segmentPartPath(id, sid), this.#segmentEncryptedPath(id, sid)]) {
        if (await exists(candidate)) {
          await this.#assertSafeExistingPath(candidate, { file: true });
          await unlink(candidate);
        }
      }
      session.segments.splice(index, 1);
      await this.#writePrivateSession(id, session);
      return true;
    });
  }

  async listSegments(sessionId) {
    return this.#serialize(async () => {
      this.#assertReady();
      const session = await this.#requireSession(safeId(sessionId, "sessionId"));
      return structuredClone(session.segments);
    });
  }

  async writeTranscript(sessionId, transcript) {
    return this.#writeSessionArtifact(sessionId, "transcript", transcript);
  }

  async readTranscript(sessionId) {
    return this.#readSessionArtifact(sessionId, "transcript");
  }

  async writeAnalysis(sessionId, analysis) {
    return this.#writeSessionArtifact(sessionId, "analysis", analysis);
  }

  async readAnalysis(sessionId) {
    return this.#readSessionArtifact(sessionId, "analysis");
  }

  async purgeExpired() {
    return this.#serialize(async () => {
      this.#assertReady();
      return this.#purgeExpiredInternal();
    });
  }

  async deleteSession(sessionId) {
    return this.#serialize(async () => {
      this.#assertReady();
      const id = safeId(sessionId, "sessionId");
      if (!this.#index.has(id)) return false;
      try {
        await this.#deleteTreeSafe(this.#sessionDir(id));
      } catch (error) {
        const entry = this.#index.get(id);
        entry.failureCode = "DELETE_FAILED";
        await this.#persistIndex().catch(() => {});
        throw new VoiceArchiveError("DELETE_FAILED", "voice session deletion failed", { cause: error });
      }
      this.#index.delete(id);
      await this.#persistIndex();
      return true;
    });
  }

  async materializeTranscriptionInput(sessionId) {
    return this.#serialize(async () => {
      this.#assertReady();
      const id = safeId(sessionId, "sessionId");
      const session = await this.#requireSession(id);
      const finalized = session.segments.filter((segment) => segment.state === "finalized");
      if (!finalized.length) throw new VoiceArchiveError("NO_SEGMENTS", "voice session has no finalized segments");
      const workspaceId = randomUUID().replaceAll("-", "");
      const workspaceDir = path.join(this.#workDir, workspaceId);
      await this.#assertSafeParent(workspaceDir);
      await mkdir(workspaceDir, { mode: 0o700 });
      const manifest = {
        version: 1,
        sessionStartedAtMs: Date.parse(session.createdAt),
        segments: [],
      };
      try {
        for (const segment of finalized) {
          const wavPath = path.join(workspaceDir, `${segment.segmentId}.wav`);
          await this.#decryptFile(
            this.#segmentEncryptedPath(id, segment.segmentId),
            wavPath,
            this.#aad("segment", id, segment.segmentId),
          );
          manifest.segments.push({
            speakerId: segment.speakerId,
            speakerName: segment.speakerName,
            startedAtMs: segment.startedAtMs,
            wavPath,
          });
        }
        const manifestPath = path.join(workspaceDir, "manifest.json");
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        return { workspaceId, workspaceDir, manifestPath };
      } catch (error) {
        await this.#deleteTreeSafe(workspaceDir).catch(() => {});
        throw error;
      }
    });
  }

  async cleanupTranscriptionInput(workspaceId) {
    return this.#serialize(async () => {
      this.#assertReady();
      const id = safeId(workspaceId, "workspaceId");
      const target = path.join(this.#workDir, id);
      if (!(await exists(target))) return false;
      await this.#deleteTreeSafe(target);
      return true;
    });
  }

  async close() {
    return this.#serialize(async () => {
      this.#key.fill(0);
      this.#closed = true;
      this.#initialized = false;
    });
  }

  async #writeSessionArtifact(sessionId, type, value) {
    return this.#serialize(async () => {
      this.#assertReady();
      const id = safeId(sessionId, "sessionId");
      await this.#requireSession(id);
      const encoded = Buffer.from(JSON.stringify(value), "utf8");
      if (encoded.length > 32 * 1024 * 1024) throw new VoiceArchiveError("ARTIFACT_TOO_LARGE", `${type} is too large`);
      await this.#writeEncryptedBuffer(this.#artifactPath(id, type), encoded, this.#aad(type, id));
      return true;
    });
  }

  async #readSessionArtifact(sessionId, type) {
    return this.#serialize(async () => {
      this.#assertReady();
      const id = safeId(sessionId, "sessionId");
      await this.#requireSession(id);
      const target = this.#artifactPath(id, type);
      if (!(await exists(target))) return null;
      const decoded = await this.#readEncryptedBuffer(target, this.#aad(type, id));
      try {
        return JSON.parse(decoded.toString("utf8"));
      } catch (error) {
        throw new VoiceArchiveError("CORRUPT_ARTIFACT", `encrypted ${type} is not valid JSON`, { cause: error });
      }
    });
  }

  async #purgeExpiredInternal() {
    const now = dateMs(this.#now(), "now");
    let purged = 0;
    let failures = 0;
    for (const [sessionId, entry] of [...this.#index]) {
      if (Date.parse(entry.expiresAt) > now) continue;
      try {
        await this.#deleteTreeSafe(this.#sessionDir(sessionId));
        this.#index.delete(sessionId);
        purged += 1;
      } catch {
        entry.failureCode = "PURGE_DELETE_FAILED";
        failures += 1;
      }
    }
    if (purged || failures) await this.#persistIndex();
    if (failures) {
      this.#logger?.error?.("voice archive purge failed", { failureCode: "PURGE_DELETE_FAILED", count: failures });
      throw new VoiceArchiveError("PURGE_DELETE_FAILED", "one or more expired voice sessions could not be deleted");
    }
    return { purged, failures: 0 };
  }

  async #removeStaleParts() {
    for (const [sessionId] of this.#index) {
      const sessionDir = this.#sessionDir(sessionId);
      await this.#assertSafeExistingPath(sessionDir, { directory: true });
      const segmentsDir = path.join(sessionDir, "segments");
      await this.#assertSafeExistingPath(segmentsDir, { directory: true });
      const entries = await readdir(segmentsDir, { withFileTypes: true });
      const staleIds = new Set();
      for (const entry of entries) {
        const candidate = path.join(segmentsDir, entry.name);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
          throw new VoiceArchiveError("UNSAFE_PATH", "archive contains a link or special filesystem entry");
        }
        if (!entry.name.endsWith(".wav.part")) continue;
        const segmentId = entry.name.slice(0, -".wav.part".length);
        safeId(segmentId, "segmentId");
        await this.#assertSafeExistingPath(candidate, { file: true });
        try {
          await unlink(candidate);
          staleIds.add(segmentId);
        } catch (error) {
          throw new VoiceArchiveError("STALE_PLAINTEXT_DELETE_FAILED", "stale plaintext audio could not be deleted", { cause: error });
        }
      }
      if (staleIds.size) {
        const session = await this.#getSessionInternal(sessionId);
        for (const segment of session.segments) {
          if (staleIds.has(segment.segmentId) && segment.state === "recording") segment.state = "discarded_after_restart";
        }
        session.failureCode = "STALE_PART_REMOVED";
        await this.#writePrivateSession(sessionId, session);
        const indexEntry = this.#index.get(sessionId);
        indexEntry.failureCode = "STALE_PART_REMOVED";
      }
    }
    await this.#persistIndex();
    const workEntries = await readdir(this.#workDir, { withFileTypes: true });
    for (const entry of workEntries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new VoiceArchiveError("UNSAFE_PATH", "transcription workspace contains an unsafe filesystem entry");
      }
      safeId(entry.name, "workspaceId");
      await this.#deleteTreeSafe(path.join(this.#workDir, entry.name));
    }
  }

  async #loadIndex() {
    const indexPath = path.join(this.#rootDir, INDEX_FILE);
    if (!(await exists(indexPath))) {
      await this.#persistIndex();
      return;
    }
    await this.#assertSafeExistingPath(indexPath, { file: true });
    let parsed;
    try {
      parsed = JSON.parse(await readFile(indexPath, "utf8"));
    } catch (error) {
      throw new VoiceArchiveError("CORRUPT_INDEX", "voice archive index cannot be read", { cause: error });
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions) || parsed.sessions.some((entry) => !exactIndexEntry(entry))) {
      throw new VoiceArchiveError("CORRUPT_INDEX", "voice archive index has an invalid shape");
    }
    this.#index = new Map(parsed.sessions.map((entry) => [entry.sessionId, structuredClone(entry)]));
    if (this.#index.size !== parsed.sessions.length) throw new VoiceArchiveError("CORRUPT_INDEX", "voice archive index contains duplicates");
  }

  async #persistIndex() {
    const indexPath = path.join(this.#rootDir, INDEX_FILE);
    const tempPath = path.join(this.#rootDir, `.index-${randomUUID()}.tmp`);
    const payload = {
      version: 1,
      sessions: [...this.#index.values()].map((entry) => ({
        sessionId: entry.sessionId,
        state: entry.state,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        failureCode: entry.failureCode,
      })),
    };
    await writeFile(tempPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tempPath, indexPath).catch(async (error) => {
      await unlink(tempPath).catch(() => {});
      throw error;
    });
    await chmod(indexPath, 0o600).catch(() => {});
  }

  async #getSessionInternal(sessionId) {
    const entry = this.#index.get(sessionId);
    if (!entry) return null;
    const privateMeta = await this.#readEncryptedJson(this.#metadataPath(sessionId), this.#aad("metadata", sessionId));
    if (privateMeta.sessionId !== sessionId
      || privateMeta.createdAt !== entry.createdAt
      || privateMeta.expiresAt !== entry.expiresAt) {
      throw new VoiceArchiveError("CORRUPT_METADATA", "encrypted session metadata does not match its index");
    }
    return { ...privateMeta, ...structuredClone(entry) };
  }

  async #requireSession(sessionId) {
    const session = await this.#getSessionInternal(sessionId);
    if (!session) throw new VoiceArchiveError("SESSION_NOT_FOUND", "voice session was not found");
    return session;
  }

  async #writePrivateSession(sessionId, session) {
    const privateMeta = { ...session };
    await this.#writeEncryptedJson(this.#metadataPath(sessionId), privateMeta, this.#aad("metadata", sessionId));
  }

  async #writeEncryptedJson(target, value, aad) {
    const encoded = Buffer.from(JSON.stringify(value), "utf8");
    if (encoded.length > 8 * 1024 * 1024) {
      throw new VoiceArchiveError("METADATA_TOO_LARGE", "encrypted archive metadata exceeds its local limit");
    }
    await this.#writeEncryptedBuffer(target, encoded, aad);
  }

  async #readEncryptedJson(target, aad) {
    const decoded = await this.#readEncryptedBuffer(target, aad);
    try {
      return JSON.parse(decoded.toString("utf8"));
    } catch (error) {
      throw new VoiceArchiveError("CORRUPT_METADATA", "encrypted archive metadata is not valid JSON", { cause: error });
    }
  }

  async #writeEncryptedBuffer(target, plaintext, aad) {
    await this.#assertSafeParent(target);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = Buffer.concat([ENCRYPTED_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
    const tempPath = `${target}.${randomUUID()}.tmp`;
    await writeFile(tempPath, envelope, { mode: 0o600, flag: "wx" });
    await rename(tempPath, target).catch(async (error) => {
      await unlink(tempPath).catch(() => {});
      throw error;
    });
  }

  async #readEncryptedBuffer(target, aad) {
    await this.#assertSafeExistingPath(target, { file: true });
    const envelope = await readFile(target);
    if (envelope.length < HEADER_BYTES || !envelope.subarray(0, 4).equals(ENCRYPTED_MAGIC)) {
      throw new VoiceArchiveError("CORRUPT_CIPHERTEXT", "encrypted archive file has an invalid header");
    }
    try {
      const iv = envelope.subarray(4, 4 + IV_BYTES);
      const tag = envelope.subarray(4 + IV_BYTES, HEADER_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(envelope.subarray(HEADER_BYTES)), decipher.final()]);
    } catch (error) {
      throw new VoiceArchiveError("AUTHENTICATION_FAILED", "encrypted archive file failed authentication", { cause: error });
    }
  }

  async #encryptFile(source, target, aad) {
    await this.#assertSafeExistingPath(source, { file: true });
    await this.#assertSafeParent(target);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const tempPath = `${target}.${randomUUID()}.tmp`;
    const header = Buffer.concat([ENCRYPTED_MAGIC, iv, Buffer.alloc(TAG_BYTES)]);
    try {
      await writeFile(tempPath, header, { mode: 0o600, flag: "wx" });
      await pipeline(createReadStream(source), cipher, createWriteStream(tempPath, { flags: "a", mode: 0o600 }));
      const handle = await open(tempPath, "r+");
      try {
        await handle.write(cipher.getAuthTag(), 0, TAG_BYTES, 4 + IV_BYTES);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, target);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async #decryptFile(source, target, aad) {
    await this.#assertSafeExistingPath(source, { file: true });
    await this.#assertSafeParent(target);
    const handle = await open(source, "r");
    let header;
    try {
      header = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0);
      if (bytesRead !== HEADER_BYTES || !header.subarray(0, 4).equals(ENCRYPTED_MAGIC)) {
        throw new VoiceArchiveError("CORRUPT_CIPHERTEXT", "encrypted audio has an invalid header");
      }
    } finally {
      await handle.close();
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, header.subarray(4, 4 + IV_BYTES));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(header.subarray(4 + IV_BYTES, HEADER_BYTES));
    try {
      await pipeline(
        createReadStream(source, { start: HEADER_BYTES }),
        decipher,
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
      );
    } catch (error) {
      await unlink(target).catch(() => {});
      throw new VoiceArchiveError("AUTHENTICATION_FAILED", "encrypted audio failed authentication", { cause: error });
    }
  }

  #sessionDir(sessionId) {
    const target = path.join(this.#sessionsDir, safeId(sessionId, "sessionId"));
    if (!isWithin(this.#sessionsDir, target)) throw new VoiceArchiveError("UNSAFE_PATH", "session path escapes archive root");
    return target;
  }

  #metadataPath(sessionId) {
    return path.join(this.#sessionDir(sessionId), "metadata.enc");
  }

  #artifactPath(sessionId, type) {
    if (!new Set(["transcript", "analysis"]).has(type)) throw new VoiceArchiveError("UNSAFE_PATH", "unsupported artifact type");
    return path.join(this.#sessionDir(sessionId), `${type}.enc`);
  }

  #segmentPartPath(sessionId, segmentId) {
    return path.join(this.#sessionDir(sessionId), "segments", `${safeId(segmentId, "segmentId")}.wav.part`);
  }

  #segmentEncryptedPath(sessionId, segmentId) {
    return path.join(this.#sessionDir(sessionId), "segments", `${safeId(segmentId, "segmentId")}.wav.enc`);
  }

  #aad(type, sessionId, segmentId = "") {
    return `voice-session-archive:v1:${type}:${sessionId}:${segmentId}`;
  }

  async #assertRootIsPhysicalDirectory() {
    const stats = await lstat(this.#rootDir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new VoiceArchiveError("UNSAFE_PATH", "voice archive root must be a physical directory");
    }
    let current = this.#rootDir;
    while (true) {
      const component = await lstat(current);
      if (component.isSymbolicLink()) {
        throw new VoiceArchiveError("UNSAFE_PATH", "voice archive root may not traverse links or reparse points");
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  async #assertSafeParent(target) {
    const resolved = path.resolve(target);
    if (!isWithin(this.#rootDir, resolved)) throw new VoiceArchiveError("UNSAFE_PATH", "archive path escapes root");
    let current = path.dirname(resolved);
    const paths = [];
    while (isWithin(this.#rootDir, current) && current !== this.#rootDir) {
      paths.push(current);
      current = path.dirname(current);
    }
    paths.push(this.#rootDir);
    for (const candidate of paths.reverse()) {
      if (!(await exists(candidate))) continue;
      const stats = await lstat(candidate);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new VoiceArchiveError("UNSAFE_PATH", "archive parent contains a link or non-directory entry");
      }
    }
  }

  async #assertSafeExistingPath(target, { file = false, directory = false } = {}) {
    await this.#assertSafeParent(target);
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || (file && !stats.isFile()) || (directory && !stats.isDirectory())) {
      throw new VoiceArchiveError("UNSAFE_PATH", "archive entry has an unsafe filesystem type");
    }
  }

  async #deleteTreeSafe(target) {
    const resolved = path.resolve(target);
    if (resolved === this.#rootDir || !isWithin(this.#rootDir, resolved)) {
      throw new VoiceArchiveError("UNSAFE_PATH", "refusing to delete outside a child archive path");
    }
    if (!(await exists(resolved))) return;
    await this.#assertSafeExistingPath(resolved, { directory: true });
    const entries = await readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(resolved, entry.name);
      if (entry.isSymbolicLink()) throw new VoiceArchiveError("UNSAFE_PATH", "refusing to traverse a link during deletion");
      if (entry.isDirectory()) await this.#deleteTreeSafe(candidate);
      else if (entry.isFile()) {
        await this.#assertSafeExistingPath(candidate, { file: true });
        await unlink(candidate);
      } else {
        throw new VoiceArchiveError("UNSAFE_PATH", "refusing to delete a special filesystem entry");
      }
    }
    await rmdir(resolved);
  }

  #assertReady() {
    if (this.#closed) throw new VoiceArchiveError("ARCHIVE_CLOSED", "voice archive is closed");
    if (!this.#initialized) throw new VoiceArchiveError("ARCHIVE_NOT_INITIALIZED", "voice archive is not initialized");
  }

  #serialize(operation) {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.catch(() => {});
    return result;
  }
}

export const VOICE_ARCHIVE_RETENTION_MS = RETENTION_MS;
