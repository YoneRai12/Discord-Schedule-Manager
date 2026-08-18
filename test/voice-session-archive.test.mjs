import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import {
  VOICE_ARCHIVE_RETENTION_MS,
  VoiceSessionArchive,
} from "../src/voice/voice-session-archive.mjs";
import { WavSegmentWriter } from "../src/voice/wav-segment-writer.mjs";

function key() {
  return randomBytes(32).toString("base64");
}

function testSnowflake(prefix) {
  return `${prefix}${"234567890"}${"12345678"}`;
}

async function allFileBytes(root) {
  const output = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(await readFile(target));
    }
  }
  await visit(root);
  return Buffer.concat(output);
}

test("session private metadata, segments, transcript, and analysis remain encrypted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-archive-"));
  const archiveKey = key();
  const started = Date.parse("2026-08-01T00:00:00.000Z");
  const archive = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey, now: () => started });
  await archive.initialize();
  const session = await archive.createSession({
    sessionId: "session_safe_1",
    guildId: testSnowflake(1),
    voiceChannelId: testSnowflake(2),
    outputChannelId: testSnowflake(3),
    requestedById: testSnowflake(4),
    title: "PRIVATE_MEETING_TITLE",
    consents: { [testSnowflake(5)]: true },
    noticeMessageId: testSnowflake(7),
    requiredUserIds: [testSnowflake(8)],
    consentedUserIds: [testSnowflake(9)],
    policyRevision: "voice-policy-v1",
    startedAtMs: started + 100,
    state: "recording",
  });
  assert.equal(session.expiresAt, "2026-08-02T00:00:00.000Z");
  assert.equal(session.createdAtMs, started);
  assert.equal(session.expiresAtMs, started + VOICE_ARCHIVE_RETENTION_MS);
  assert.deepEqual(session.requiredUserIds, [testSnowflake(8)]);
  const consented = await archive.updateSession("session_safe_1", {
    consent: {
      userId: testSnowflake(9),
      decision: "allow",
      decidedAtMs: started + 50,
      policyRevision: "voice-policy-v1",
    },
  });
  assert.equal(consented.consents.length, 1);

  const { segmentId, tempPath } = await archive.createSegment("session_safe_1", {
    speakerId: testSnowflake(6),
    speakerName: "PRIVATE_SPEAKER_NAME",
    startedAtMs: 125,
  });
  const writer = new WavSegmentWriter({ filePath: tempPath });
  writer.end(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  await finished(writer);
  await archive.finalizeSegment("session_safe_1", segmentId, { endedAtMs: 250 });
  await assert.rejects(stat(tempPath), (error) => error?.code === "ENOENT");

  const segments = await archive.listSegments("session_safe_1");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].speakerName, "PRIVATE_SPEAKER_NAME");
  assert.equal(segments[0].state, "finalized");
  const workspace = await archive.materializeTranscriptionInput("session_safe_1");
  const manifest = JSON.parse(await readFile(workspace.manifestPath, "utf8"));
  assert.equal(manifest.sessionStartedAtMs, started);
  assert.equal(manifest.segments[0].speakerName, "PRIVATE_SPEAKER_NAME");
  assert.deepEqual(
    (await readFile(manifest.segments[0].wavPath)).subarray(44),
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
  );
  await archive.cleanupTranscriptionInput(workspace.workspaceId);
  await assert.rejects(stat(workspace.workspaceDir), (error) => error?.code === "ENOENT");
  await archive.writeTranscript("session_safe_1", { text: "PRIVATE_TRANSCRIPT_BODY" });
  await archive.writeAnalysis("session_safe_1", { summary: "PRIVATE_ANALYSIS_BODY" });
  assert.deepEqual(await archive.readTranscript("session_safe_1"), { text: "PRIVATE_TRANSCRIPT_BODY" });
  assert.deepEqual(await archive.readAnalysis("session_safe_1"), { summary: "PRIVATE_ANALYSIS_BODY" });

  const plaintextIndex = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  assert.deepEqual(Object.keys(plaintextIndex.sessions[0]).sort(), [
    "createdAt",
    "expiresAt",
    "failureCode",
    "sessionId",
    "state",
  ]);
  const disk = (await allFileBytes(root)).toString("utf8");
  for (const secret of [
    testSnowflake(1),
    testSnowflake(7),
    testSnowflake(8),
    "PRIVATE_MEETING_TITLE",
    "PRIVATE_SPEAKER_NAME",
    "PRIVATE_TRANSCRIPT_BODY",
    "PRIVATE_ANALYSIS_BODY",
  ]) {
    assert.equal(disk.includes(secret), false, secret);
  }

  await archive.close();
  const reopened = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey, now: () => started });
  await reopened.initialize();
  assert.equal((await reopened.getSession("session_safe_1")).title, "PRIVATE_MEETING_TITLE");
  await reopened.close();
});

test("expiry stays fixed at session start plus 24 hours and purge removes expired data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-expiry-"));
  let now = Date.parse("2026-08-01T02:00:00.000Z");
  const archive = new VoiceSessionArchive({ rootDir: root, encryptionKey: key(), now: () => now });
  await archive.initialize();
  const created = await archive.createSession({ sessionId: "ttl_session", title: "secret" });
  now += 23 * 60 * 60 * 1_000;
  const updated = await archive.updateSession("ttl_session", { state: "processing", title: "changed" });
  assert.equal(updated.expiresAt, created.expiresAt);
  await assert.rejects(
    archive.updateSession("ttl_session", { expiresAtMs: now + 99 * VOICE_ARCHIVE_RETENTION_MS }),
    (error) => error?.code === "IMMUTABLE_SESSION_FIELD",
  );
  assert.equal((await archive.purgeExpired()).purged, 0);
  now += 60 * 60 * 1_000;
  assert.deepEqual(await archive.purgeExpired({ excludeSessionIds: ["ttl_session"] }), { purged: 0, failures: 0 });
  assert.equal((await archive.getSession("ttl_session")).state, "processing");
  assert.deepEqual(await archive.purgeExpired(), { purged: 1, failures: 0 });
  assert.equal(await archive.getSession("ttl_session"), null);
  assert.throws(
    () => new VoiceSessionArchive({ rootDir: root, encryptionKey: key(), retentionMs: VOICE_ARCHIVE_RETENTION_MS + 1 }),
    (error) => error?.code === "INVALID_RETENTION",
  );
  await archive.close();
});

test("unsafe IDs and symlink or junction replacements are rejected fail-closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-path-"));
  let now = Date.parse("2026-08-01T04:00:00.000Z");
  const archive = new VoiceSessionArchive({ rootDir: root, encryptionKey: key(), now: () => now });
  await archive.initialize();
  await assert.rejects(
    archive.createSession({ sessionId: "..\\escape", title: "secret" }),
    (error) => error?.code === "UNSAFE_PATH",
  );
  await archive.createSession({ sessionId: "linked_session", title: "secret" });
  const sessionDir = path.join(root, "sessions", "linked_session");
  const outside = await mkdtemp(path.join(os.tmpdir(), "voice-outside-"));
  await rm(sessionDir, { recursive: true, force: true });
  try {
    await symlink(outside, sessionDir, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("symlink creation is unavailable on this host");
      await archive.close();
      return;
    }
    throw error;
  }
  await assert.rejects(archive.getSession("linked_session"), (error) => error?.code === "UNSAFE_PATH");
  now += VOICE_ARCHIVE_RETENTION_MS;
  await assert.rejects(archive.purgeExpired(), (error) => error?.code === "PURGE_DELETE_FAILED");
  const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  assert.equal(index.sessions[0].failureCode, "PURGE_DELETE_FAILED");
  await archive.close();
});

test("initialize removes stale plaintext parts without extending expiry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-stale-"));
  const archiveKey = key();
  const now = Date.parse("2026-08-01T05:00:00.000Z");
  const first = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey, now: () => now });
  await first.initialize();
  const created = await first.createSession({ sessionId: "stale_session", title: "secret" });
  const segment = await first.createSegment("stale_session", {
    speakerId: "1",
    speakerName: "private",
    startedAtMs: 0,
  });
  await writeFile(segment.tempPath, Buffer.from("plaintext-crash-remnant"));
  await first.close();

  const second = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey, now: () => now + 1_000 });
  await second.initialize();
  await assert.rejects(stat(segment.tempPath), (error) => error?.code === "ENOENT");
  const recovered = await second.getSession("stale_session");
  assert.equal(recovered.expiresAt, created.expiresAt);
  assert.equal(recovered.failureCode, "STALE_PART_REMOVED");
  assert.equal(recovered.segments[0].state, "discarded_after_restart");
  await second.close();
});

test("同じ音声アーカイブを別process相当のinstanceが同時利用できない", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-archive-lock-"));
  const archiveKey = key();
  const first = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey });
  const second = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey });
  await first.initialize();

  await assert.rejects(
    second.initialize(),
    (error) => error?.code === "ARCHIVE_IN_USE",
  );

  await first.close();
  await second.initialize();
  await second.close();
  await rm(root, { recursive: true, force: true });
});

test("所有processが強制終了してもOS管理lockが自動解放される", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-archive-process-lock-"));
  const archiveKey = key();
  const moduleUrl = new URL("../src/voice/voice-session-archive.mjs", import.meta.url).href;
  const childCode = [
    `import { VoiceSessionArchive } from ${JSON.stringify(moduleUrl)};`,
    `const archive = new VoiceSessionArchive({ rootDir: ${JSON.stringify(root)}, encryptionKey: ${JSON.stringify(archiveKey)} });`,
    "await archive.initialize();",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childCode], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child archive did not initialize")), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child archive exited early (${code})`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (!chunk.includes("ready")) return;
      clearTimeout(timer);
      resolve();
    });
  });

  const contender = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey });
  await assert.rejects(contender.initialize(), (error) => error?.code === "ARCHIVE_IN_USE");
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));

  await contender.initialize();
  await contender.close();
  await rm(root, { recursive: true, force: true });
});

test("再処理state claimはarchive内部でcompare-and-setされる", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-archive-transition-"));
  const archive = new VoiceSessionArchive({ rootDir: root, encryptionKey: key() });
  await archive.initialize();
  await archive.createSession({ sessionId: "transition_session", state: "processing_failed" });

  const results = await Promise.all([
    archive.transitionSession("transition_session", ["processing_failed"], { state: "reprocessing" }),
    archive.transitionSession("transition_session", ["processing_failed"], { state: "reprocessing" }),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  assert.equal((await archive.getSession("transition_session")).state, "reprocessing");
  await archive.close();
  await rm(root, { recursive: true, force: true });
});

test("再処理中の異常終了stateは次回lock取得後に再試行可能へ戻る", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-archive-recovery-"));
  const archiveKey = key();
  const first = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey });
  await first.initialize();
  await first.createSession({ sessionId: "reprocess_interrupted", state: "reprocessing" });
  await first.createSession({ sessionId: "reanalyze_interrupted", state: "reanalyzing" });
  await first.close();

  const second = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey });
  await second.initialize();
  const reprocess = await second.getSession("reprocess_interrupted");
  const reanalyze = await second.getSession("reanalyze_interrupted");
  assert.equal(reprocess.state, "processing_failed");
  assert.equal(reprocess.failureCode, "PROCESS_INTERRUPTED");
  assert.equal(reanalyze.state, "analysis_failed");
  assert.equal(reanalyze.failureCode, "ANALYSIS_INTERRUPTED");
  await second.close();
  await rm(root, { recursive: true, force: true });
});

test("通常の文字起こし処理中にPCが終了しても次回起動で再処理可能へ戻る", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-archive-processing-recovery-"));
  const archiveKey = key();
  const first = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey });
  await first.initialize();
  await first.createSession({ sessionId: "processing_interrupted", state: "processing" });
  await first.close();

  const second = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey });
  await second.initialize();
  const recovered = await second.getSession("processing_interrupted");
  assert.equal(recovered.state, "processing_failed");
  assert.equal(recovered.failureCode, "PROCESS_INTERRUPTED");
  assert.deepEqual((await second.listSessions({ states: ["processing_failed"] })).map((item) => item.sessionId), [
    "processing_interrupted",
  ]);
  await second.close();
  await rm(root, { recursive: true, force: true });
});

test("停止処理中のPC終了で未確定segmentを除去しても中断理由を保持する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-archive-stopping-recovery-"));
  const archiveKey = key();
  const first = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey });
  await first.initialize();
  await first.createSession({ sessionId: "stopping_interrupted", state: "stopping" });
  await first.createSegment("stopping_interrupted", {
    speakerId: "participant",
    speakerName: "参加者",
    startedAtMs: Date.now(),
  });
  await first.close();

  const second = new VoiceSessionArchive({ rootDir: root, encryptionKey: archiveKey });
  await second.initialize();
  const recovered = await second.getSession("stopping_interrupted");
  assert.equal(recovered.state, "processing_failed");
  assert.equal(recovered.failureCode, "PROCESS_INTERRUPTED");
  assert.equal(recovered.segments[0].state, "discarded_after_restart");
  await second.close();
  await rm(root, { recursive: true, force: true });
});
