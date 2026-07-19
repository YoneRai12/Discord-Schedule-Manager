import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildWebProjection } from "../src/web-projection.mjs";
import { MeetingWebSync, signWebSyncRequest } from "../src/web-sync.mjs";

const SECRET = "template-test-secret-not-for-production";
const GENERATED_AT_MS = Date.UTC(2030, 0, 1);
const snowflake = (digit) => String(digit).repeat(18);

function privateSnapshot() {
  return {
    meetings: [{
      id: "PRIVATE1",
      guildId: snowflake(1),
      channelId: snowflake(2),
      messageId: snowflake(3),
      createdById: snowflake(4),
      createdByName: "非公開の主催者名",
      title: "非公開の定例 https://meet.example.invalid/private",
      startsAtMs: Date.UTC(2030, 0, 2, 3, 4),
      endsAtMs: Date.UTC(2030, 0, 2, 4, 4),
      meetingUrl: "https://meet.example.invalid/private",
      reminderMinutes: [0, 60, 10, 60],
      status: "active",
    }],
    rsvps: [
      { meetingId: "PRIVATE1", userId: snowflake(5), displayName: "非公開の参加者名", status: "attending" },
      { meetingId: "PRIVATE1", userId: snowflake(6), displayName: "別の非公開名", status: "declined" },
    ],
    invitees: [
      { meetingId: "PRIVATE1", userId: snowflake(5), displayName: "回答者名", deliveryStatus: "sent" },
      { meetingId: "PRIVATE1", userId: snowflake(7), displayName: "未回答者名", deliveryStatus: "sent" },
    ],
    memberAliases: [{ userId: snowflake(8), alias: "秘密の呼び名", displayName: "台帳氏名" }],
    personalReminderPreferences: [{ userId: snowflake(9), reminderMinutes: [60, 10] }],
    deliveries: [{ meetingId: "PRIVATE1", discordMessageId: snowflake(1), lastErrorCode: "private" }],
  };
}

function projection(secret = SECRET) {
  return buildWebProjection(privateSnapshot(), {
    publicIdSecret: secret,
    generatedAtMs: GENERATED_AT_MS,
  });
}

test("確定payload契約のexact keysだけを公開し、秘密情報を一切含めない", () => {
  const payload = projection();
  const json = JSON.stringify(payload);
  const meeting = payload.meetings[0];

  assert.deepEqual(Object.keys(payload), ["schemaVersion", "sourceRevision", "generatedAtMs", "meetings"]);
  assert.deepEqual(Object.keys(meeting), [
    "id", "startsAtMs", "endsAtMs", "status", "reminderMinutes", "urlState", "attendance",
  ]);
  assert.deepEqual(Object.keys(meeting.attendance), ["attending", "maybe", "declined", "unanswered"]);
  assert.match(meeting.id, /^[A-Z0-9_-]{1,32}$/u);
  assert.equal(meeting.id.length, 16);
  assert.notEqual(meeting.id, "PRIVATE1");
  assert.equal(meeting.urlState, "registered");
  assert.deepEqual(meeting.reminderMinutes, [60, 10, 0]);
  assert.deepEqual(meeting.attendance, { attending: 1, maybe: 0, declined: 1, unanswered: 1 });
  assert.doesNotMatch(json, /meetingUrl|guildId|channelId|messageId|userId|displayName|alias|title|deliver(?:y|ies)/iu);
  assert.doesNotMatch(json, /https?:\/\//iu);
  assert.doesNotMatch(json, /\d{16,20}/u);
  assert.doesNotMatch(json, /PRIVATE1|非公開|秘密|回答者|台帳/u);
});

test("匿名idとsourceRevisionは同じ内容で安定し、秘密または公開内容変更時に変わる", () => {
  const first = projection();
  const second = projection();
  const rotated = projection(`${SECRET}-rotated`);
  const changedSnapshot = privateSnapshot();
  changedSnapshot.meetings[0].status = "cancelled";
  const changed = buildWebProjection(changedSnapshot, {
    publicIdSecret: SECRET,
    generatedAtMs: GENERATED_AT_MS,
  });
  assert.equal(first.meetings[0].id, second.meetings[0].id);
  assert.equal(first.sourceRevision, second.sourceRevision);
  assert.notEqual(first.meetings[0].id, rotated.meetings[0].id);
  assert.notEqual(first.sourceRevision, changed.sourceRevision);
  assert.match(first.sourceRevision, /^sha256:[a-f0-9]{64}$/u);
});

test("pathname・13桁timestampMs・nonce・本文hashを確定canonicalで署名して再試行する", async () => {
  const requests = [];
  const sleeps = [];
  const nowMs = 1_900_000_000_000;
  const sync = new MeetingWebSync({
    url: "https://web-sync.example.invalid/api/internal/v1/projection?source=local",
    secret: SECRET,
    store: { getSnapshot: privateSnapshot },
    fetchImpl: async (_url, request) => {
      requests.push(request);
      return { ok: requests.length > 1, status: requests.length > 1 ? 204 : 503 };
    },
    now: () => nowMs,
    nonce: () => `nonce-template-${requests.length + 1}`,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    logger: { warn: () => {}, error: () => {} },
  });

  const result = await sync.sync();

  assert.equal(result.sent, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(sleeps, [250]);
  const request = requests[0];
  assert.equal(request.redirect, "error");
  const payload = JSON.parse(request.body);
  const timestamp = request.headers["x-meeting-sync-timestamp"];
  const nonce = request.headers["x-meeting-sync-nonce"];
  const hash = crypto.createHash("sha256").update(request.body).digest("hex");
  assert.equal(timestamp, String(nowMs));
  assert.equal(payload.generatedAtMs, nowMs);
  assert.equal(request.headers["x-meeting-sync-body-sha256"], hash);
  const expected = signWebSyncRequest({
    secret: SECRET,
    pathname: "/api/internal/v1/projection",
    timestampMs: timestamp,
    nonce,
    body: request.body,
  });
  assert.equal(request.headers["x-meeting-sync-signature"], expected.signature);
  assert.equal(request.headers["x-meeting-timestamp"], undefined);
  assert.equal(request.headers["x-meeting-signature"], undefined);
});

test("受信側sync-auth契約と共有する固定署名ベクトル", () => {
  const body = "{\"schemaVersion\":1,\"sourceRevision\":\"revision-001\",\"generatedAtMs\":1780000000000,\"meetings\":[]}";
  const signed = signWebSyncRequest({
    secret: "0123456789abcdef0123456789abcdef",
    pathname: "/api/internal/v1/projection",
    timestampMs: "1780000000000",
    nonce: "fixed_nonce_0001",
    body,
  });
  assert.equal(signed.bodyHash, "7a4c6272ac9e096790f407cc4077fbba8a9c94a74ace630e7299a775c44952a1");
  assert.equal(signed.signature, "49999332a1c373633e20e7ab8510e274178360982f830b08edc8849c0f150eea");
});

test("URLかsecretが片方でも未設定ならsnapshotもHTTPも完全に使わない", async () => {
  let snapshots = 0;
  let requests = 0;
  const sync = new MeetingWebSync({
    url: "https://web-sync.example.invalid/api/internal/v1/projection",
    secret: "",
    store: { getSnapshot: () => { snapshots += 1; return privateSnapshot(); } },
    fetchImpl: async () => { requests += 1; return { ok: true, status: 204 }; },
  });

  assert.equal(sync.configured, false);
  assert.equal(sync.start(), false);
  assert.deepEqual(await sync.sync(), { configured: false, sent: false });
  assert.equal(snapshots, 0);
  assert.equal(requests, 0);
});

test("短いsecretはHTTP設定の有無にかかわらず起動時に拒否する", () => {
  assert.throws(
    () => new MeetingWebSync({ url: "", secret: "too-short" }),
    /at least 32 characters/u,
  );
  assert.throws(
    () => new MeetingWebSync({
      url: "https://web-sync.example.invalid/api/internal/v1/projection",
      secret: "too-short",
    }),
    /at least 32 characters/u,
  );
});

test("同時syncは単一POSTへまとめる", async () => {
  let requests = 0;
  let resolveRequest;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const sync = new MeetingWebSync({
    url: "https://web-sync.example.invalid/api/internal/v1/projection",
    secret: SECRET,
    store: { getSnapshot: privateSnapshot },
    fetchImpl: async () => {
      requests += 1;
      await pending;
      return { ok: true, status: 204 };
    },
    now: () => GENERATED_AT_MS,
  });

  const first = sync.sync();
  const second = sync.sync();
  resolveRequest();
  await Promise.all([first, second]);
  assert.equal(requests, 1);
});

test("外部同期URLはHTTPS限定で、URL埋め込み認証情報を拒否する", () => {
  const options = {
    secret: SECRET,
    store: { getSnapshot: privateSnapshot },
    fetchImpl: async () => ({ ok: true, status: 204 }),
  };
  assert.throws(
    () => new MeetingWebSync({ ...options, url: "http://web-sync.example.invalid/snapshot" }),
    /HTTPS/u,
  );
  assert.throws(
    () => new MeetingWebSync({ ...options, url: "https://user:password@web-sync.example.invalid/snapshot" }),
    /credentials/u,
  );
});
