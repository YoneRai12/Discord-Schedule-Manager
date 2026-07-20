import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MeetingDatabase } from "../src/database.mjs";
import { MeetingCardUpdateScheduler } from "../src/meeting-card-update-scheduler.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-card-update-"));
  const store = new MeetingDatabase(path.join(root, "meetings.sqlite3"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const startsAtMs = Date.now() + 60 * 60_000;
  const meeting = store.createMeeting({
    id: "CARD1234",
    guildId: "guild-example",
    channelId: "channel-example",
    createdById: "admin-example",
    createdByName: "admin",
    title: "initial title",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.example.com/original",
    reminderMinutes: [],
    everyoneOffsets: [],
  });
  store.setMessageId(meeting.id, "card-message");
  return { store, meeting };
}

function cardClient({ onEdit = null } = {}) {
  const edits = [];
  const message = {
    async edit(payload) {
      edits.push(payload);
      await onEdit?.(payload);
      return { id: "card-message" };
    },
  };
  return {
    edits,
    client: {
      channels: {
        async fetch() {
          return {
            isTextBased: () => true,
            messages: { fetch: async () => message },
          };
        },
      },
    },
  };
}

test("card outbox stores only the durable meeting reference and queues with the meeting update", (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, {
    title: "new title",
    meetingUrl: "https://meet.example.com/private-new",
  });
  const columns = store.db.prepare("PRAGMA table_info(meeting_card_updates)").all().map((row) => row.name);
  assert.equal(columns.some((name) => /url|title|content|message|channel|discord/i.test(name)), false);
  const [claim] = store.claimMeetingCardUpdates({ nowMs: Date.now(), leaseMs: 1_000 });
  assert.deepEqual(Object.keys(claim).sort(), ["attempts", "claimToken", "meetingId", "targetCardRevision"]);
  assert.equal(claim.targetCardRevision, updated.cardRevision);
  assert.equal(store.getMeetingCardUpdateData(claim).meeting.meetingUrl, "https://meet.example.com/private-new");
});

test("RSVP atomically advances the card generation and invalidates an older claim", (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, { title: "first revision" });
  const [oldClaim] = store.claimMeetingCardUpdates({ nowMs: Date.now(), leaseMs: 1_000 });
  store.upsertRsvp(updated.id, { userId: "member-example", displayName: "member", status: "attending" });
  assert.equal(store.isMeetingCardUpdateClaimCurrent(oldClaim), false);
  assert.equal(store.markMeetingCardUpdateSucceeded(oldClaim), false);
  const [currentClaim] = store.claimMeetingCardUpdates({ nowMs: Date.now(), leaseMs: 1_000 });
  const data = store.getMeetingCardUpdateData(currentClaim);
  assert.equal(data.meeting.cardRevision, updated.cardRevision + 1);
  assert.equal(data.rsvps[0].status, "attending");
});

test("cancellation advances the card generation and queues the existing card in the same database transaction", (t) => {
  const { store, meeting } = fixture(t);
  const cancelled = store.cancelMeeting(meeting.id);
  const [claim] = store.claimMeetingCardUpdates({ nowMs: Date.now(), leaseMs: 1_000 });
  assert.equal(claim.targetCardRevision, cancelled.cardRevision);
  assert.equal(store.getMeetingCardUpdateData(claim).meeting.status, "cancelled");
});

test("expired card leases are recovered after restart with a fresh claim token", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-card-restart-"));
  const databasePath = path.join(root, "meetings.sqlite3");
  let store = new MeetingDatabase(databasePath);
  t.after(() => {
    try { store.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const startsAtMs = Date.now() + 60 * 60_000;
  const meeting = store.createMeeting({
    id: "CARDREST",
    guildId: "guild-example",
    channelId: "channel-example",
    createdById: "admin-example",
    createdByName: "admin",
    title: "restart",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.example.com/restart",
    reminderMinutes: [],
    everyoneOffsets: [],
  });
  store.setMessageId(meeting.id, "card-message");
  store.updateMeeting(meeting.id, { title: "restart update" });
  const [first] = store.claimMeetingCardUpdates({ nowMs: 1_000, leaseMs: 1_000 });
  store.close();
  store = new MeetingDatabase(databasePath);
  assert.deepEqual(store.claimMeetingCardUpdates({ nowMs: 1_999, leaseMs: 1_000 }), []);
  const [recovered] = store.claimMeetingCardUpdates({ nowMs: 2_000, leaseMs: 1_000 });
  assert.notEqual(recovered.claimToken, first.claimToken);
});

test("scheduler rebuilds the latest payload, retries temporary failures, and permanently skips Discord terminal errors", async (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, { title: "delivery title" });
  const transport = cardClient();
  const scheduler = new MeetingCardUpdateScheduler({
    store,
    client: transport.client,
    logger: { warn() {}, error() {} },
  });
  const delivered = await scheduler.tick();
  assert.deepEqual({ claimed: delivered.claimed, updated: delivered.updated, failed: delivered.failed }, { claimed: 1, updated: 1, failed: 0 });
  assert.equal(transport.edits.length, 1);
  assert.match(transport.edits[0].embeds[0].data.title, /delivery title/);

  store.updateMeeting(updated.id, { title: "temporary failure" });
  scheduler.client = cardClient({ onEdit: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } }).client;
  const retry = await scheduler.tick();
  assert.equal(retry.failed, 1);
  assert.ok(store.getMeetingCardUpdateSummary(updated.id).nextAttemptAtMs > 0);

  const newer = store.updateMeeting(updated.id, { title: "terminal failure" });
  scheduler.client = {
    channels: {
      async fetch() { throw Object.assign(new Error("missing"), { code: 10003 }); },
    },
  };
  const terminal = await scheduler.tick();
  assert.equal(terminal.skipped, 1);
  assert.equal(store.getMeetingCardUpdateSummary(newer.id).skipped, 1);
});

test("a newer update during an edit cannot be acknowledged by the stale claim", async (t) => {
  const { store, meeting } = fixture(t);
  store.updateMeeting(meeting.id, { title: "claimed" });
  const transport = cardClient({
    onEdit: async () => { store.updateMeeting(meeting.id, { title: "newer than edit" }); },
  });
  const scheduler = new MeetingCardUpdateScheduler({
    store,
    client: transport.client,
    logger: { warn() {}, error() {} },
  });
  const result = await scheduler.tick();
  assert.equal(result.stale, 1);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id).pending, 1);
});

test("a stale edit arriving after the latest receipt requeues the latest card for self-repair", async (t) => {
  const { store, meeting } = fixture(t);
  store.updateMeeting(meeting.id, { title: "old generation" });

  let releaseOldEdit;
  let signalOldEditStarted;
  const oldEditStarted = new Promise((resolve) => { signalOldEditStarted = resolve; });
  const oldEditCanFinish = new Promise((resolve) => { releaseOldEdit = resolve; });
  const oldTransport = cardClient({
    onEdit: async () => {
      signalOldEditStarted();
      await oldEditCanFinish;
    },
  });
  const quietLogger = { warn() {}, error() {} };
  const oldScheduler = new MeetingCardUpdateScheduler({
    store,
    client: oldTransport.client,
    logger: quietLogger,
  });
  const oldTick = oldScheduler.tick();
  await oldEditStarted;

  store.updateMeeting(meeting.id, { title: "latest generation" });
  const latestTransport = cardClient();
  const latestScheduler = new MeetingCardUpdateScheduler({
    store,
    client: latestTransport.client,
    logger: quietLogger,
  });
  const latestTick = await latestScheduler.tick();
  assert.equal(latestTick.updated, 1);
  assert.match(latestTransport.edits[0].embeds[0].data.title, /latest generation/);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id).unresolved, 0);

  releaseOldEdit();
  const staleTick = await oldTick;
  assert.equal(staleTick.stale, 1);
  assert.match(oldTransport.edits[0].embeds[0].data.title, /old generation/);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id).pending, 1);

  const repairedTick = await latestScheduler.tick();
  assert.equal(repairedTick.updated, 1);
  assert.equal(latestTransport.edits.length, 2);
  assert.match(latestTransport.edits[1].embeds[0].data.title, /latest generation/);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id).unresolved, 0);
});

test("10008 recreates the latest meeting card and atomically adopts only its message id", async (t) => {
  const { store, meeting } = fixture(t);
  const updated = store.updateMeeting(meeting.id, { title: "recreated card" });
  const sent = [];
  const client = {
    channels: {
      async fetch() {
        return {
          guildId: updated.guildId,
          isTextBased: () => true,
          messages: {
            async fetch() {
              throw Object.assign(new Error("deleted"), { code: 10008 });
            },
          },
          async send(payload) {
            sent.push(payload);
            return { id: "replacement-card", async delete() {} };
          },
        };
      },
    },
  };
  const scheduler = new MeetingCardUpdateScheduler({
    store,
    client,
    logger: { warn() {}, error() {} },
  });

  const result = await scheduler.tick();
  assert.equal(result.updated, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.title, /recreated card/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(sent[0].enforceNonce, true);
  assert.match(sent[0].nonce, /^[a-f0-9]{24}$/u);
  const adopted = store.getMeeting(meeting.id);
  assert.equal(adopted.messageId, "replacement-card");
  assert.equal(adopted.updatedAtMs, updated.updatedAtMs);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id).unresolved, 0);
});

for (const terminalCode of [10003, 50001]) {
  test(`${terminalCode} does not recreate a meeting card`, async (t) => {
    const { store, meeting } = fixture(t);
    store.updateMeeting(meeting.id, { title: "must not recreate" });
    let sends = 0;
    const client = {
      channels: {
        async fetch() {
          if (terminalCode === 10003) {
            throw Object.assign(new Error("terminal"), { code: terminalCode });
          }
          return {
            isTextBased: () => true,
            messages: {
              async fetch() {
                throw Object.assign(new Error("terminal"), { code: terminalCode });
              },
            },
            async send() { sends += 1; },
          };
        },
      },
    };
    const scheduler = new MeetingCardUpdateScheduler({
      store,
      client,
      logger: { warn() {}, error() {} },
    });

    const result = await scheduler.tick();
    assert.equal(result.skipped, 1);
    assert.equal(sends, 0);
    assert.equal(store.getMeeting(meeting.id).messageId, "card-message");
  });
}

test("a stale recreation cannot adopt its card after a newer generation succeeds", async (t) => {
  const { store, meeting } = fixture(t);
  store.updateMeeting(meeting.id, { title: "old recreation" });
  const messages = new Map();
  const deleted = [];
  let releaseOldSend;
  let signalOldSendStarted;
  const oldSendStarted = new Promise((resolve) => { signalOldSendStarted = resolve; });
  const oldSendCanFinish = new Promise((resolve) => { releaseOldSend = resolve; });

  const messageFor = (id, payload) => ({
    id,
    async edit(nextPayload) { messages.set(id, messageFor(id, nextPayload)); },
    async delete() { deleted.push(id); messages.delete(id); },
    payload,
  });
  const makeClient = ({ newMessageId, stallSend = false }) => ({
    channels: {
      async fetch() {
        return {
          guildId: "guild-example",
          isTextBased: () => true,
          messages: {
            async fetch(id) {
              const current = messages.get(id);
              if (!current) throw Object.assign(new Error("deleted"), { code: 10008 });
              return current;
            },
          },
          async send(payload) {
            if (stallSend) {
              signalOldSendStarted();
              await oldSendCanFinish;
            }
            const created = messageFor(newMessageId, payload);
            messages.set(newMessageId, created);
            return created;
          },
        };
      },
    },
  });
  const quietLogger = { warn() {}, error() {} };
  const oldScheduler = new MeetingCardUpdateScheduler({
    store,
    client: makeClient({ newMessageId: "stale-card", stallSend: true }),
    logger: quietLogger,
  });
  const oldTick = oldScheduler.tick();
  await oldSendStarted;

  store.updateMeeting(meeting.id, { title: "latest recreation" });
  const latestScheduler = new MeetingCardUpdateScheduler({
    store,
    client: makeClient({ newMessageId: "latest-card" }),
    logger: quietLogger,
  });
  const latestTick = await latestScheduler.tick();
  assert.equal(latestTick.updated, 1);
  assert.equal(store.getMeeting(meeting.id).messageId, "latest-card");

  releaseOldSend();
  const staleTick = await oldTick;
  assert.equal(staleTick.stale, 1);
  assert.equal(store.getMeeting(meeting.id).messageId, "latest-card");
  assert.deepEqual(deleted, ["stale-card"]);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id).pending, 1);

  const repairedTick = await latestScheduler.tick();
  assert.equal(repairedTick.updated, 1);
  assert.match(messages.get("latest-card").payload.embeds[0].data.title, /latest recreation/);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id).unresolved, 0);
});

test("a reclaimed same-revision lease never deletes the canonical nonce-deduplicated card", async (t) => {
  const { store, meeting } = fixture(t);
  store.updateMeeting(meeting.id, { title: "same revision" });
  let releaseOldSend;
  let signalOldSendStarted;
  const oldSendStarted = new Promise((resolve) => { signalOldSendStarted = resolve; });
  const oldSendCanFinish = new Promise((resolve) => { releaseOldSend = resolve; });
  const nonces = [];
  let deletes = 0;
  const canonical = {
    id: "nonce-deduplicated-card",
    async edit() {},
    async delete() { deletes += 1; },
  };
  const makeClient = ({ stallSend = false, cardExists = false } = {}) => ({
    channels: {
      async fetch() {
        return {
          guildId: "guild-example",
          isTextBased: () => true,
          messages: {
            async fetch() {
              if (cardExists) return canonical;
              throw Object.assign(new Error("deleted"), { code: 10008 });
            },
          },
          async send(payload) {
            nonces.push(payload.nonce);
            if (stallSend) {
              signalOldSendStarted();
              await oldSendCanFinish;
            }
            return canonical;
          },
        };
      },
    },
  });
  const quietLogger = { warn() {}, error() {} };
  const oldScheduler = new MeetingCardUpdateScheduler({
    store,
    client: makeClient({ stallSend: true }),
    leaseMs: 1_000,
    now: () => 1_000,
    logger: quietLogger,
  });
  const oldTick = oldScheduler.tick();
  await oldSendStarted;

  const reclaimedScheduler = new MeetingCardUpdateScheduler({
    store,
    client: makeClient(),
    leaseMs: 1_000,
    now: () => 2_000,
    logger: quietLogger,
  });
  const reclaimedTick = await reclaimedScheduler.tick();
  assert.equal(reclaimedTick.updated, 1);
  assert.equal(store.getMeeting(meeting.id).messageId, canonical.id);

  releaseOldSend();
  const staleTick = await oldTick;
  assert.equal(staleTick.stale, 1);
  assert.equal(nonces.length, 2);
  assert.equal(nonces[0], nonces[1]);
  assert.equal(deletes, 0);
  assert.equal(store.getMeeting(meeting.id).messageId, canonical.id);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id).pending, 1);

  reclaimedScheduler.client = makeClient({ cardExists: true });
  const repairedTick = await reclaimedScheduler.tick();
  assert.equal(repairedTick.updated, 1);
  assert.equal(deletes, 0);
  assert.equal(store.getMeetingCardUpdateSummary(meeting.id).unresolved, 0);
});
