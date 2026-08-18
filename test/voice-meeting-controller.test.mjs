import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { VoiceMeetingController } from "../src/voice/voice-meeting-controller.mjs";

const fakeId = (prefix) => `${prefix}${"234567890"}${"12345678"}`;
const GUILD_ID = fakeId(1);
const OUTPUT_CHANNEL_ID = fakeId(2);
const VOICE_CHANNEL_ID = fakeId(3);
const ACTOR_ID = fakeId(4);
const PARTICIPANT_ID = fakeId(5);
const NEW_PARTICIPANT_ID = fakeId(6);

function fakeArchive({ failRecordingUpdate = false } = {}) {
  const sessions = new Map();
  const updates = [];
  const events = [];
  return {
    sessions,
    updates,
    events,
    async initialize() {},
    async purgeExpired() { return { deleted: 0, failed: 0 }; },
    async createSession(record) {
      const stored = { ...record, consents: [] };
      sessions.set(record.sessionId, stored);
      return stored;
    },
    async getSession(id) { return sessions.get(id) || null; },
    async listSessions({ states = [], limit = 100 } = {}) {
      const filter = new Set(states);
      return [...sessions.values()].filter((session) => !filter.size || filter.has(session.state)).slice(0, limit);
    },
    async updateSession(id, patch) {
      if (failRecordingUpdate && patch.state === "recording") {
        throw Object.assign(new Error("recording state write failed"), { code: "STATE_WRITE_FAILED" });
      }
      updates.push({ id, patch });
      const current = sessions.get(id) || {};
      const next = { ...current, ...patch };
      if (patch.consent) next.consents = [...(current.consents || []), patch.consent];
      sessions.set(id, next);
      return sessions.get(id);
    },
    async transitionSession(id, expectedStates, patch) {
      const current = sessions.get(id);
      if (!current || !expectedStates.includes(current.state)) return null;
      return this.updateSession(id, patch);
    },
    async writeTranscript(id, transcript) {
      sessions.set(id, { ...(sessions.get(id) || {}), transcript });
    },
    async readTranscript(id) { return sessions.get(id)?.transcript || null; },
    async writeAnalysis(id, analysis) {
      sessions.set(id, { ...(sessions.get(id) || {}), analysis });
    },
    async deleteSession(id) { events.push(`delete:${id}`); sessions.delete(id); },
    async close() { events.push("close"); },
  };
}

function fakeReceiver() {
  const calls = { start: [], pause: 0, resume: 0, stop: [], consentSets: [] };
  let connected = false;
  return {
    calls,
    async start(options) { calls.start.push(options); connected = true; },
    async pause() { calls.pause += 1; },
    resume() { calls.resume += 1; },
    async stop(options) { calls.stop.push(options); connected = false; },
    setConsentedUserIds(ids) { calls.consentSets.push([...ids]); },
    isConnected() { return connected; },
    setConnected(value) { connected = Boolean(value); },
  };
}

function buildDiscord({ everyoneViewDenied = true, invisibleMemberId = null, failProcessingSend = false } = {}) {
  const sent = [];
  const voiceSent = [];
  const edited = [];
  const notice = {
    id: fakeId(7),
    async edit(payload) {
      edited.push(payload);
      return this;
    },
    async delete() {},
  };
  const voiceChannel = {
    id: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    type: ChannelType.GuildVoice,
    members: new Map(),
    permissionsFor() { return { has: () => true }; },
    messages: { async fetch() { return notice; } },
    async send(payload) {
      voiceSent.push(payload);
      return notice;
    },
  };
  const memberById = new Map();
  const addMember = (id) => {
    const member = {
      id,
      displayName: `参加者-${id.slice(-4)}`,
      user: { id, bot: false },
      voice: { channel: voiceChannel, channelId: VOICE_CHANNEL_ID },
    };
    memberById.set(id, member);
    voiceChannel.members.set(id, member);
    return member;
  };
  const actor = addMember(ACTOR_ID);
  const participant = addMember(PARTICIPANT_ID);

  const outputChannel = {
    id: OUTPUT_CHANNEL_ID,
    guildId: GUILD_ID,
    type: ChannelType.GuildText,
    permissionOverwrites: {
      cache: new Map([["everyone-role", {
        deny: { has: (permission) => everyoneViewDenied && permission === PermissionFlagsBits.ViewChannel },
      }]]),
    },
    permissionsFor(subject) {
      return { has: () => String(subject?.id || "") !== String(invisibleMemberId || "") };
    },
    messages: { async fetch() { return notice; } },
    async send(payload) {
      if (failProcessingSend && /録音終了・VC退出済み/u.test(payload?.content || "")) {
        throw Object.assign(new Error("temporary Discord failure"), { code: "ETIMEDOUT" });
      }
      sent.push(payload);
      return sent.length === 1 ? notice : { id: String(BigInt(fakeId(7)) + BigInt(sent.length)) };
    },
  };
  const guild = {
    id: GUILD_ID,
    roles: { everyone: { id: "everyone-role" } },
    members: {
      me: { id: "bot" },
      async fetch(id) { return memberById.get(String(id)); },
    },
    channels: {
      async fetch(id) {
        if (id === OUTPUT_CHANNEL_ID) return outputChannel;
        if (id === VOICE_CHANNEL_ID) return voiceChannel;
        return null;
      },
    },
  };
  const client = {
    user: { id: "bot" },
    guilds: { async fetch(id) { return id === GUILD_ID ? guild : null; } },
  };
  return {
    client,
    guild,
    voiceChannel,
    outputChannel,
    actor,
    participant,
    sent,
    voiceSent,
    edited,
    addMember,
  };
}

function interaction(customId, userId, replies) {
  return {
    customId,
    user: { id: userId },
    isButton: () => true,
    async reply(payload) { replies.push(payload); },
  };
}

function controllerFixture(options = {}) {
  const discord = buildDiscord(options);
  const archive = options.archive || fakeArchive({ failRecordingUpdate: options.failRecordingUpdate });
  const receiver = fakeReceiver();
  const controller = new VoiceMeetingController({
    client: discord.client,
    guildId: GUILD_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    archive,
    receiver,
    transcriber: options.transcriber || {
      async transcribeSession() { return { version: 1, segments: [] }; },
    },
    analyzer: options.analyzer,
    publisher: options.publisher,
    enabled: true,
    summaryEnabled: false,
    factCheckEnabled: false,
    validateAutomaticSession: options.validateAutomaticSession,
    releaseAutomaticSession: options.releaseAutomaticSession,
    automaticValidationIntervalMs: options.automaticValidationIntervalMs,
    sessionWatchdogIntervalMs: options.sessionWatchdogIntervalMs,
    emptyVoiceGraceMs: options.emptyVoiceGraceMs,
    connectionLossGraceMs: options.connectionLossGraceMs,
    analysisRetryPollMs: options.analysisRetryPollMs,
    now: options.now || (() => 1_800_000_000_000),
    logger: options.logger || { warn() {}, error() {} },
  });
  return { controller, archive, receiver, ...discord };
}

function clearControllerTimers(controller) {
  clearTimeout(controller.maxTimer);
  clearInterval(controller.noticeTimer);
  clearInterval(controller.janitorTimer);
  clearInterval(controller.automaticValidationTimer);
  clearInterval(controller.sessionWatchdogTimer);
  clearInterval(controller.analysisRetryTimer);
  for (const timer of controller.processingExpiryTimers.values()) clearTimeout(timer);
  for (const timer of controller.analysisRetryExpiryTimers.values()) clearTimeout(timer);
}

test("全員同意前はreceiverを開始せず、全員同意後だけ開始する", async (t) => {
  const fixture = controllerFixture();
  const { controller, receiver, sent, edited } = fixture;
  const replies = [];
  t.after(() => clearControllerTimers(controller));

  const started = await controller.requestStart({ user: { id: ACTOR_ID } }, { title: "週次会議" });
  assert.equal(receiver.calls.start.length, 0);
  assert.equal(controller.session.state, "pending_consent");
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });

  await controller.handleButton(interaction(`voice:consent:${started.sessionId}`, ACTOR_ID, replies));
  assert.equal(receiver.calls.start.length, 0);
  assert.equal(controller.session.state, "pending_consent");

  await controller.handleButton(interaction(`voice:consent:${started.sessionId}`, PARTICIPANT_ID, replies));
  assert.equal(receiver.calls.start.length, 1);
  assert.equal(controller.session.state, "recording");
  assert.deepEqual(new Set(receiver.calls.start[0].consentedUserIds), new Set([ACTOR_ID, PARTICIPANT_ID]));
  assert.ok(edited.some((payload) => /文字起こし中/u.test(payload.content)));
  assert.ok(replies.every((payload) => payload.allowedMentions?.parse?.length === 0));
});

test("予定の指定VCはDB確定後に同意ボタンなしで自動録音を開始する", async (t) => {
  const fixture = controllerFixture();
  const { controller, receiver, guild, voiceChannel, sent, voiceSent } = fixture;
  t.after(() => clearControllerTimers(controller));

  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    title: "予定済み会議",
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  assert.equal(controller.session.id, started.sessionId);
  assert.equal(controller.session.state, "pending_consent");
  assert.equal(receiver.calls.start.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(await controller.confirmAutomaticPending(started.sessionId), true);
  assert.equal(controller.session.state, "recording");
  assert.equal(receiver.calls.start.length, 1);
  assert.equal(voiceSent.length, 1);
  assert.match(voiceSent[0].content, /自動文字起こしを開始/u);
  assert.doesNotMatch(voiceSent[0].content, /同意確認/u);
});

test("同時同意を直列化しreceiver開始と同意監査記録を一度ずつ保持する", async (t) => {
  const fixture = controllerFixture();
  const { controller, receiver, archive } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStart({ user: { id: ACTOR_ID } });

  const results = await Promise.all([
    controller.consent({ user: { id: ACTOR_ID } }),
    controller.consent({ user: { id: PARTICIPANT_ID } }),
  ]);

  assert.equal(receiver.calls.start.length, 1);
  assert.equal(controller.session.state, "recording");
  assert.equal(results.filter((result) => result.allConsented).length, 1);
  assert.deepEqual(
    new Set(archive.sessions.get(started.sessionId).consents.map((item) => item.userId)),
    new Set([ACTOR_ID, PARTICIPANT_ID]),
  );
});

test("録音直前に予定が無効ならreceiverを開始せずpendingを解放する", async (t) => {
  const validations = [];
  const releases = [];
  const fixture = controllerFixture({
    validateAutomaticSession: async (context) => {
      validations.push(context);
      return { valid: false, reason: "meeting_rescheduled" };
    },
    releaseAutomaticSession: async (context) => releases.push(context),
  });
  const { controller, receiver, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  assert.equal(await controller.confirmAutomaticPending(started.sessionId), false);
  assert.equal(receiver.calls.start.length, 0);
  assert.equal(controller.session, null);
  assert.equal(validations.at(-1).sessionId, started.sessionId);
  assert.equal(validations.at(-1).sourceMeetingId, "MEET0001");
  assert.equal(validations.at(-1).voiceChannelId, VOICE_CHANNEL_ID);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].reason, "meeting_rescheduled");
});

test("自動予定はDB finalize前には録音せずconfirm後に一度だけ開始する", async (t) => {
  const fixture = controllerFixture({ validateAutomaticSession: async () => true });
  const { controller, receiver, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });

  assert.equal(receiver.calls.start.length, 0);
  assert.equal(controller.session.state, "pending_consent");

  assert.equal(await controller.confirmAutomaticPending(started.sessionId), true);
  assert.equal(receiver.calls.start.length, 1);
  assert.equal(controller.session.state, "recording");
  assert.equal(await controller.confirmAutomaticPending(started.sessionId), false);
});

test("取消済みまたは別session IDのautomatic pendingはconfirmを拒否する", async (t) => {
  const fixture = controllerFixture();
  const { controller, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });

  assert.equal(await controller.confirmAutomaticPending("FFFFFFFFFF"), false);
  assert.equal(controller.session.id, started.sessionId);
  assert.equal(await controller.cancelAutomaticPending({
    expectedSessionId: started.sessionId,
    reason: "claim_finalize_failed",
    retryable: true,
  }), true);
  assert.equal(await controller.confirmAutomaticPending(started.sessionId), false);
});

test("finalize失敗など外部取消は再試行可能に解放し、明示denyは解放しない", async (t) => {
  const releases = [];
  const first = controllerFixture({
    releaseAutomaticSession: async (context) => releases.push(context),
  });
  t.after(() => clearControllerTimers(first.controller));
  const started = await first.controller.requestStartForVoiceChannel({
    guild: first.guild,
    voiceChannel: first.voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  assert.equal(await first.controller.cancelAutomaticPending({
    expectedSessionId: started.sessionId,
    reason: "claim_finalize_failed",
    retryable: true,
  }), true);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].reason, "claim_finalize_failed");

  const second = controllerFixture({
    releaseAutomaticSession: async (context) => releases.push(context),
  });
  t.after(() => clearControllerTimers(second.controller));
  const denied = await second.controller.requestStartForVoiceChannel({
    guild: second.guild,
    voiceChannel: second.voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0002",
  });
  await second.controller.decline({ user: { id: ACTOR_ID } });
  assert.equal(second.controller.session, null);
  assert.equal(releases.length, 1);
  assert.deepEqual(second.controller.consumeAutomaticPendingOutcome(denied.sessionId), {
    retryable: false,
    reason: "consent_denied",
  });
  assert.equal(second.controller.consumeAutomaticPendingOutcome(denied.sessionId), null);
});

test("自動予定は参加者が議事録チャンネルを見られなくてもVC録音を開始できる", async (t) => {
  const fixture = controllerFixture({
    invisibleMemberId: NEW_PARTICIPANT_ID,
    validateAutomaticSession: async () => true,
  });
  const { controller, receiver, addMember, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  assert.equal(await controller.confirmAutomaticPending(started.sessionId), true);
  const newcomer = addMember(NEW_PARTICIPANT_ID);

  assert.equal(await controller.handleVoiceStateUpdate(
    { guild, channelId: null, member: newcomer },
    { guild, channelId: VOICE_CHANNEL_ID, member: newcomer },
  ), true);
  assert.equal(controller.session.state, "recording");
  assert.equal(receiver.calls.start.length, 1);
  assert.equal(receiver.calls.pause, 0);
  assert.equal(controller.session.consentedUserIds.has(NEW_PARTICIPANT_ID), true);
  assert.equal(fixture.voiceSent.length, 1);
});

test("VCチャットでBotへ会議終了を伝えるとローカル判定で停止し、元の表示を処理中へ更新する", async (t) => {
  const fixture = controllerFixture({ validateAutomaticSession: async () => true });
  const { controller, receiver, guild, voiceChannel, actor, edited } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  await controller.confirmAutomaticPending(started.sessionId);
  const reactions = [];

  assert.equal(await controller.handleMeetingEndMessage({
    id: fakeId(8),
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    author: { id: ACTOR_ID, bot: false },
    member: actor,
    content: "<@bot> 会議終わったよ",
    mentions: { users: { has: (id) => id === "bot" } },
    async react(value) { reactions.push(value); },
  }), true);
  await Promise.allSettled([...controller.processing.values()]);

  assert.equal(receiver.calls.stop.length, 1);
  assert.equal(controller.session, null);
  assert.deepEqual(reactions, ["✅"]);
  assert.ok(edited.some((payload) => /VCから退出済み/u.test(payload.content || "")));
  assert.ok(edited.some((payload) => /処理が完了/u.test(payload.content || "")));
});

test("会議終了予定の質問や条件文は停止命令へ誤判定しない", async (t) => {
  const fixture = controllerFixture({ validateAutomaticSession: async () => true });
  const { controller, receiver, guild, voiceChannel, actor } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  await controller.confirmAutomaticPending(started.sessionId);
  const base = {
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    author: { id: ACTOR_ID, bot: false },
    member: actor,
    mentions: { users: { has: (id) => id === "bot" } },
  };

  assert.equal(await controller.handleMeetingEndMessage({ ...base, content: "<@bot> 会議終了予定を教えて" }), false);
  assert.equal(await controller.handleMeetingEndMessage({ ...base, content: "<@bot> 会議が終わったら次を教えて" }), false);
  assert.equal(await controller.handleMeetingEndMessage({ ...base, content: "<@bot> 会議終わった？" }), false);
  assert.equal(await controller.handleMeetingEndMessage({ ...base, content: "<@bot> 終了?" }), false);
  assert.equal(receiver.calls.stop.length, 0);
  assert.equal(controller.session?.state, "recording");
});

test("VCイベントを取りこぼしても空室監視で自動停止する", async (t) => {
  let nowMs = 1_800_000_000_000;
  const fixture = controllerFixture({
    validateAutomaticSession: async () => true,
    emptyVoiceGraceMs: 1_000,
    now: () => nowMs,
  });
  const { controller, receiver, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  await controller.confirmAutomaticPending(started.sessionId);
  voiceChannel.members.clear();

  assert.equal(await controller.reconcileActiveSession(), false);
  nowMs += 1_001;
  assert.equal(await controller.reconcileActiveSession(), true);
  assert.equal(receiver.calls.stop.length, 1);
  assert.equal(controller.session, null);
  await Promise.allSettled([...controller.processing.values()]);
});

test("BotのVC接続断が猶予時間を超えたら録音中表示を続けず自動停止する", async (t) => {
  let nowMs = 1_800_000_000_000;
  const fixture = controllerFixture({
    validateAutomaticSession: async () => true,
    connectionLossGraceMs: 1_000,
    now: () => nowMs,
  });
  const { controller, receiver, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  await controller.confirmAutomaticPending(started.sessionId);
  receiver.setConnected(false);

  assert.equal(await controller.reconcileActiveSession(), false);
  nowMs += 1_001;
  assert.equal(await controller.reconcileActiveSession(), true);
  assert.equal(receiver.calls.stop.length, 1);
  assert.equal(controller.session, null);
  await Promise.allSettled([...controller.processing.values()]);
});

test("手動会議の途中参加同意待ち中でもVC接続断を監視して自動停止する", async (t) => {
  let nowMs = 1_800_000_000_000;
  const fixture = controllerFixture({ connectionLossGraceMs: 1_000, now: () => nowMs });
  const { controller, receiver, addMember, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  await controller.requestStart({ user: { id: ACTOR_ID } });
  await controller.consent({ user: { id: ACTOR_ID } });
  await controller.consent({ user: { id: PARTICIPANT_ID } });
  const newcomer = addMember(NEW_PARTICIPANT_ID);
  await controller.handleVoiceStateUpdate(
    { guild, channelId: null, member: newcomer },
    { guild, channelId: VOICE_CHANNEL_ID, member: newcomer },
  );
  assert.equal(controller.session.state, "paused_for_consent");
  receiver.setConnected(false);

  assert.equal(await controller.reconcileActiveSession(), false);
  nowMs += 1_001;
  assert.equal(await controller.reconcileActiveSession(), true);
  assert.equal(receiver.calls.stop.length, 1);
  assert.equal(controller.session, null);
  await Promise.allSettled([...controller.processing.values()]);
});

test("VC接続後に録音状態を保存できなければreceiverを止めて自動開始を解放する", async (t) => {
  const releases = [];
  const fixture = controllerFixture({
    validateAutomaticSession: async () => true,
    releaseAutomaticSession: async (context) => releases.push(context),
    failRecordingUpdate: true,
  });
  const { controller, receiver, guild, voiceChannel, archive } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });

  await assert.rejects(controller.confirmAutomaticPending(started.sessionId), (error) => error?.code === "STATE_WRITE_FAILED");
  assert.equal(receiver.calls.start.length, 1);
  assert.deepEqual(receiver.calls.stop, [{ discardActive: true }]);
  assert.equal(controller.session, null);
  assert.equal(archive.sessions.size, 0);
  assert.equal(releases.at(-1)?.reason, "recording_state_persist_failed");
});

test("結果placeholderの送信に失敗したら文字起こしを開始せず安全側で保持する", async (t) => {
  let transcriberCalls = 0;
  const fixture = controllerFixture({
    validateAutomaticSession: async () => true,
    failProcessingSend: true,
    transcriber: { async transcribeSession() { transcriberCalls += 1; return { version: 1, segments: [] }; } },
  });
  const { controller, archive, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  await controller.confirmAutomaticPending(started.sessionId);

  const stopped = await controller.stopSession({ reason: "manual", requestedById: ACTOR_ID });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.processing, false);
  assert.equal(stopped.code, "PROCESSING_MESSAGE_SEND_FAILED");
  await Promise.allSettled([...controller.processing.values()]);
  assert.equal(archive.sessions.get(started.sessionId).state, "processing_failed");
  assert.equal(archive.sessions.get(started.sessionId).failureCode, "PROCESSING_MESSAGE_SEND_FAILED");
  assert.equal(transcriberCalls, 0);
});

test("結果placeholderのcheckpoint失敗は投稿をrollbackして文字起こしを開始しない", async (t) => {
  const archive = fakeArchive();
  const updateSession = archive.updateSession.bind(archive);
  let checkpointFailed = false;
  archive.updateSession = async (id, patch) => {
    if (!checkpointFailed && patch.resultMessageId && !patch.state) {
      checkpointFailed = true;
      throw Object.assign(new Error("private storage detail"), { code: "CHECKPOINT_IO_FAILED" });
    }
    return updateSession(id, patch);
  };
  let transcriberCalls = 0;
  let deleted = 0;
  const fixture = controllerFixture({
    archive,
    transcriber: { async transcribeSession() { transcriberCalls += 1; return { version: 1, segments: [] }; } },
  });
  t.after(() => clearControllerTimers(fixture.controller));
  await fixture.controller.requestStart({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: PARTICIPANT_ID } });
  const originalSend = fixture.outputChannel.send.bind(fixture.outputChannel);
  fixture.outputChannel.send = async (payload) => {
    if (!/録音終了・VC退出済み/u.test(payload?.content || "")) return originalSend(payload);
    return { id: fakeId(8), async delete() { deleted += 1; } };
  };

  const stopped = await fixture.controller.stopSession({ reason: "manual", requestedById: ACTOR_ID });

  assert.equal(stopped.processing, false);
  assert.equal(stopped.code, "RESULT_MESSAGE_CHECKPOINT_FAILED");
  assert.equal(deleted, 1);
  assert.equal(transcriberCalls, 0);
  assert.equal(archive.sessions.get(stopped.sessionId).state, "processing_failed");
  assert.equal(archive.sessions.get(stopped.sessionId).resultMessageId, undefined);
});

test("placeholder checkpoint後のrollbackも失敗したら既知IDと固定codeを保持する", async (t) => {
  const archive = fakeArchive();
  const updateSession = archive.updateSession.bind(archive);
  let checkpointFailed = false;
  archive.updateSession = async (id, patch) => {
    if (!checkpointFailed && patch.resultMessageId && !patch.state) {
      checkpointFailed = true;
      throw Object.assign(new Error("private storage detail"), { code: "CHECKPOINT_IO_FAILED" });
    }
    return updateSession(id, patch);
  };
  let safeEdit = null;
  const fixture = controllerFixture({ archive });
  t.after(() => clearControllerTimers(fixture.controller));
  await fixture.controller.requestStart({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: PARTICIPANT_ID } });
  fixture.outputChannel.send = async () => ({
    id: fakeId(8),
    async delete() { throw new Error("private Discord detail"); },
    async edit(payload) { safeEdit = payload; },
  });

  const stopped = await fixture.controller.stopSession({ reason: "manual", requestedById: ACTOR_ID });
  const stored = archive.sessions.get(stopped.sessionId);

  assert.equal(stopped.processing, false);
  assert.equal(stopped.code, "RESULT_MESSAGE_CHECKPOINT_ROLLBACK_FAILED");
  assert.equal(stored.state, "deletion_failed");
  assert.equal(stored.failureCode, "RESULT_MESSAGE_CHECKPOINT_ROLLBACK_FAILED");
  assert.equal(stored.resultMessageId, fakeId(8));
  assert.match(safeEdit.content, /RESULT_MESSAGE_CHECKPOINT_ROLLBACK_FAILED/u);
  assert.doesNotMatch(JSON.stringify(safeEdit), /private storage detail|private Discord detail/u);
});

test("自動録音中のVCチャットを発言者付きで取り込み、最後の人の退室で自動処理する", async (t) => {
  let nowMs = 1_800_000_000_000;
  const fixture = controllerFixture({
    validateAutomaticSession: async () => true,
    emptyVoiceGraceMs: 1_000,
    now: () => nowMs,
  });
  const { controller, receiver, archive, guild, voiceChannel, actor } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  await controller.confirmAutomaticPending(started.sessionId);

  assert.equal(await controller.handleMessageCreate({
    id: fakeId(8),
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    createdTimestamp: 1_800_000_005_000,
    author: { id: ACTOR_ID, bot: false, username: "actor" },
    member: actor,
    content: "読み上げ元のチャットです",
  }), true);

  voiceChannel.members.clear();
  assert.equal(await controller.handleVoiceStateUpdate(
    { guild, channelId: VOICE_CHANNEL_ID, member: actor },
    { guild, channelId: null, member: actor },
  ), true);
  assert.notEqual(controller.session, null);
  nowMs += 1_001;
  assert.equal(await controller.reconcileActiveSession(), true);
  await Promise.allSettled([...controller.processing.values()]);

  assert.equal(receiver.calls.stop.length, 1);
  assert.equal(controller.session, null);
  const stored = archive.sessions.get(started.sessionId);
  assert.equal(stored.state, "review_pending");
  assert.deepEqual(stored.transcript.segments.map((segment) => ({
    speakerId: segment.speakerId,
    speakerName: segment.speakerName,
    text: segment.text,
    startMs: segment.startMs,
  })), [{
    speakerId: ACTOR_ID,
    speakerName: actor.displayName,
    text: "[チャット] 読み上げ元のチャットです",
    startMs: 5_000,
  }]);
});

test("同意待ち中の入退室を反映し、全員退出したら保留セッションを破棄する", async (t) => {
  const fixture = controllerFixture();
  const { controller, receiver, addMember, guild, voiceChannel, archive } = fixture;
  t.after(() => clearControllerTimers(controller));
  await controller.requestStart({ user: { id: ACTOR_ID } });

  const newcomer = addMember(NEW_PARTICIPANT_ID);
  await controller.handleVoiceStateUpdate(
    { guild, channelId: null, member: newcomer },
    { guild, channelId: VOICE_CHANNEL_ID, member: newcomer },
  );
  assert.equal(controller.session.requiredUserIds.has(NEW_PARTICIPANT_ID), true);
  assert.equal(receiver.calls.start.length, 0);

  const leaving = voiceChannel.members.get(PARTICIPANT_ID);
  voiceChannel.members.clear();
  await controller.handleVoiceStateUpdate(
    { guild, channelId: VOICE_CHANNEL_ID, member: leaving },
    { guild, channelId: null, member: leaving },
  );
  assert.equal(controller.session, null);
  assert.equal(archive.sessions.size, 0);
  assert.equal(receiver.calls.start.length, 0);
});

test("録音中の新規参加で即pauseし、その参加者を同意対象へ加える", async (t) => {
  const fixture = controllerFixture();
  const { controller, receiver, addMember, guild, voiceChannel, edited } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStart({ user: { id: ACTOR_ID } });
  await controller.consent({ user: { id: ACTOR_ID } });
  await controller.consent({ user: { id: PARTICIPANT_ID } });
  assert.equal(receiver.calls.start.length, 1);

  const newcomer = addMember(NEW_PARTICIPANT_ID);
  const handled = await controller.handleVoiceStateUpdate(
    { guild, channelId: null, member: newcomer },
    { guild, channelId: voiceChannel.id, member: newcomer },
  );
  assert.equal(handled, true);
  assert.equal(receiver.calls.pause, 1);
  assert.equal(controller.session.id, started.sessionId);
  assert.equal(controller.session.state, "paused_for_consent");
  assert.equal(controller.session.requiredUserIds.has(NEW_PARTICIPANT_ID), true);
  assert.equal(controller.session.consentedUserIds.has(NEW_PARTICIPANT_ID), false);
  assert.ok(edited.some((payload) => /一時停止/u.test(payload.content)));
  assert.ok(edited.every((payload) => payload.allowedMentions?.parse?.length === 0));
});

test("会議管理者でなくても現在の参加者は録音を停止できる", async (t) => {
  const fixture = controllerFixture();
  const { controller, receiver, sent } = fixture;
  const replies = [];
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStart({ user: { id: ACTOR_ID } });
  await controller.consent({ user: { id: ACTOR_ID } });
  await controller.consent({ user: { id: PARTICIPANT_ID } });

  const handled = await controller.handleButton(
    interaction(`voice:stop:${started.sessionId}`, PARTICIPANT_ID, replies),
  );
  assert.equal(handled, true);
  assert.equal(receiver.calls.stop.length, 1);
  assert.equal(controller.session, null);
  assert.match(replies.at(-1).content, /停止/u);
  assert.deepEqual(replies.at(-1).allowedMentions, { parse: [] });
  assert.ok(sent.every((payload) => payload.allowedMentions?.parse?.length === 0));
  await Promise.allSettled([...controller.processing.values()]);
});

test("議事録channelで@everyoneの明示denyがなくても開始できる", async (t) => {
  const fixture = controllerFixture({ everyoneViewDenied: false });
  const { controller, receiver, archive, sent } = fixture;
  t.after(() => clearControllerTimers(controller));
  await controller.requestStart({ user: { id: ACTOR_ID } });
  assert.equal(receiver.calls.start.length, 0);
  assert.equal(archive.sessions.size, 1);
  assert.equal(sent.length, 1);
  assert.equal(controller.session.state, "pending_consent");
});

test("保存済み文字起こしの要約だけを再生成し、音声文字起こしは繰り返さない", async () => {
  const analyzerCalls = [];
  const publisherCalls = [];
  const fixture = controllerFixture({
    transcriber: {
      async transcribeSession() { throw new Error("音声文字起こしを再実行してはいけません"); },
    },
    analyzer: {
      async analyze(transcript, options) {
        analyzerCalls.push({ transcript, options });
        return { aiUsed: true, factCheckUsed: false, minutes: { summary: "要約" }, factChecks: [] };
      },
    },
    publisher: {
      async publish(payload) { publisherCalls.push(payload); },
    },
  });
  const id = "A1B2C3D4E5";
  const transcript = {
    version: 1,
    segments: [{ speakerId: PARTICIPANT_ID, speakerName: "参加者", startMs: 0, endMs: 1, text: "発言" }],
  };
  fixture.archive.sessions.set(id, {
    id,
    guildId: GUILD_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    expiresAtMs: 1_800_003_600_000,
    state: "review_pending",
    resultMessageId: fakeId(7),
    transcript,
  });

  const result = await fixture.controller.reanalyze(id);

  assert.deepEqual(result, { ok: true, aiUsed: true });
  assert.equal(analyzerCalls.length, 1);
  assert.equal(publisherCalls.length, 1);
  assert.equal(publisherCalls[0].transcript, transcript);
  assert.equal(fixture.archive.sessions.get(id).state, "review_pending");
  assert.equal(fixture.controller.processing.size, 0);
});

test("AI要約の一時失敗は同一結果messageで代替表示し、1分後に文字起こしだけで自動復旧する", async (t) => {
  let nowMs = 1_800_000_000_000;
  let transcriberCalls = 0;
  let analyzerCalls = 0;
  let releaseRetry;
  const publisherCalls = [];
  const fallback = {
    aiUsed: false,
    factCheckUsed: false,
    retryable: true,
    errorCode: "timeout",
    minutes: { overview: "未確認", topics: [], decisions: [], actionItems: [], openQuestions: [] },
    factChecks: [],
  };
  const success = {
    aiUsed: true,
    factCheckUsed: false,
    minutes: { overview: "復旧済み", topics: [], decisions: [], actionItems: [], openQuestions: [] },
    factChecks: [],
  };
  const fixture = controllerFixture({
    now: () => nowMs,
    validateAutomaticSession: async () => true,
    transcriber: {
      async transcribeSession() {
        transcriberCalls += 1;
        return { version: 1, segments: [{ speakerId: ACTOR_ID, speakerName: "参加者", startMs: 0, endMs: 1, text: "発言" }] };
      },
    },
    analyzer: {
      async analyze() {
        analyzerCalls += 1;
        if (analyzerCalls === 1) return fallback;
        return new Promise((resolve) => { releaseRetry = () => resolve(success); });
      },
    },
    publisher: {
      async publish(payload) {
        publisherCalls.push(payload);
        return {
          messageId: payload.session.resultMessageId,
          publicationRevision: Number(payload.session.publicationRevision || 0) + 1,
          publicationCompletedAtMs: nowMs,
        };
      },
    },
  });
  const { controller, archive, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  const started = await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    automatic: true,
    requestedById: ACTOR_ID,
    sourceMeetingId: "MEET0001",
  });
  await controller.confirmAutomaticPending(started.sessionId);
  await controller.stopSession({ reason: "manual", requestedById: ACTOR_ID });
  await Promise.allSettled([...controller.processing.values()]);

  const placeholder = fixture.sent.find((payload) => String(payload.content || "").includes(`VOICE_RESULT:${started.sessionId}`));
  assert.equal(placeholder.nonce, `voice-result-${started.sessionId}`);
  assert.equal(placeholder.enforceNonce, true);

  const failed = archive.sessions.get(started.sessionId);
  assert.equal(failed.state, "analysis_retry_wait");
  assert.equal(failed.analysisAttemptCount, 1);
  assert.equal(failed.analysisNextAttemptAtMs, nowMs + 60_000);
  assert.equal(failed.analysisLastErrorCode, "TIMEOUT");
  assert.match(failed.resultMessageId, /^\d{16,20}$/u);
  assert.equal(publisherCalls[0].session.resultMessageId, failed.resultMessageId);

  nowMs += 60_000;
  assert.equal(await controller.runAnalysisRetryTick(), true);
  while (!releaseRetry) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.analysisRetryTasks.size, 1);
  releaseRetry();
  await Promise.allSettled([...controller.analysisRetryTasks.values()]);

  const recovered = archive.sessions.get(started.sessionId);
  assert.equal(recovered.state, "review_pending");
  assert.equal(recovered.analysisAttemptCount, 2);
  assert.equal(recovered.failureCode, null);
  assert.equal(transcriberCalls, 1);
  assert.equal(analyzerCalls, 2);
  assert.equal(publisherCalls.length, 2);
  assert.equal(publisherCalls[1].session.resultMessageId, failed.resultMessageId);
});

test("初回のDiscord公開障害もanalysis再試行待ちへ戻し、後続成功で同一messageを完了する", async (t) => {
  let nowMs = 1_800_000_000_000;
  let transcriberCalls = 0;
  let publishCalls = 0;
  const successfulAnalysis = {
    aiUsed: true,
    factCheckUsed: false,
    minutes: { overview: "要約", topics: [], decisions: [], actionItems: [], openQuestions: [] },
    factChecks: [],
  };
  const fixture = controllerFixture({
    now: () => nowMs,
    validateAutomaticSession: async () => true,
    transcriber: {
      async transcribeSession() {
        transcriberCalls += 1;
        return { version: 1, segments: [{ speakerId: ACTOR_ID, speakerName: "参加者", startMs: 0, endMs: 1, text: "発言" }] };
      },
    },
    analyzer: { async analyze() { return successfulAnalysis; } },
    publisher: {
      async publish({ session }) {
        publishCalls += 1;
        if (publishCalls === 1) throw Object.assign(new Error("discord down"), { code: "ETIMEDOUT" });
        return { messageId: session.resultMessageId, publicationRevision: 1, publicationCompletedAtMs: nowMs };
      },
    },
  });
  t.after(() => clearControllerTimers(fixture.controller));
  const started = await fixture.controller.requestStartForVoiceChannel({
    guild: fixture.guild,
    voiceChannel: fixture.voiceChannel,
    automatic: true,
    requestedById: ACTOR_ID,
    sourceMeetingId: "MEET0001",
  });
  await fixture.controller.confirmAutomaticPending(started.sessionId);
  await fixture.controller.stopSession({ reason: "manual", requestedById: ACTOR_ID });
  await Promise.allSettled([...fixture.controller.processing.values()]);
  assert.equal(fixture.archive.sessions.get(started.sessionId).state, "analysis_retry_wait");
  assert.equal(fixture.archive.sessions.get(started.sessionId).analysisLastErrorCode, "ETIMEDOUT");

  nowMs += 60_000;
  assert.equal(await fixture.controller.runAnalysisRetryTick(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.archive.sessions.get(started.sessionId).state, "review_pending");
  assert.equal(fixture.archive.sessions.get(started.sessionId).failureCode, null);
  assert.equal(transcriberCalls, 1);
  assert.equal(publishCalls, 2);
});

test("AI要約の3回目失敗は自動再試行を終え、Whisperを再実行しない", async (t) => {
  const nowMs = 1_800_000_000_000;
  let transcriberCalls = 0;
  let analyzerCalls = 0;
  const fixture = controllerFixture({
    now: () => nowMs,
    transcriber: { async transcribeSession() { transcriberCalls += 1; throw new Error("must not run"); } },
    analyzer: {
      async analyze() {
        analyzerCalls += 1;
        return {
          aiUsed: false,
          factCheckUsed: false,
          retryable: true,
          errorCode: "serverOverloaded",
          minutes: { overview: "未確認", topics: [], decisions: [], actionItems: [], openQuestions: [] },
          factChecks: [],
        };
      },
    },
    publisher: {
      async publish({ session }) {
        return { messageId: session.resultMessageId, publicationRevision: 3, publicationCompletedAtMs: nowMs };
      },
    },
  });
  t.after(() => clearControllerTimers(fixture.controller));
  const id = "ABCDEF9876";
  fixture.archive.sessions.set(id, {
    id,
    sessionId: id,
    guildId: GUILD_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    createdAtMs: nowMs - 60_000,
    expiresAtMs: nowMs + 60 * 60_000,
    state: "analysis_retry_wait",
    failureCode: "AI_RETRY_PENDING",
    analysisAttemptCount: 2,
    analysisNextAttemptAtMs: nowMs,
    resultMessageId: fakeId(7),
    publicationRevision: 2,
    transcript: { version: 1, segments: [{ speakerId: ACTOR_ID, speakerName: "参加者", startMs: 0, endMs: 1, text: "発言" }] },
  });

  assert.equal(await fixture.controller.runAnalysisRetryTick(), true);
  await new Promise((resolve) => setImmediate(resolve));
  const stored = fixture.archive.sessions.get(id);
  assert.equal(stored.state, "review_pending");
  assert.equal(stored.analysisAttemptCount, 3);
  assert.equal(stored.analysisNextAttemptAtMs, null);
  assert.equal(stored.failureCode, "AI_RETRY_EXHAUSTED");
  assert.equal(stored.analysisLastErrorCode, "SERVEROVERLOADED");
  assert.equal(analyzerCalls, 1);
  assert.equal(transcriberCalls, 0);
});

test("再起動復旧由来のattempt 3は4回目の自動AI処理を開始しない", async (t) => {
  const nowMs = 1_800_000_000_000;
  let analyzerCalls = 0;
  const fixture = controllerFixture({
    now: () => nowMs,
    analyzer: { async analyze() { analyzerCalls += 1; throw new Error("must not run"); } },
  });
  t.after(() => clearControllerTimers(fixture.controller));
  const id = "A3A3A3A3A3";
  fixture.archive.sessions.set(id, {
    id,
    sessionId: id,
    guildId: GUILD_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    expiresAtMs: nowMs + 60 * 60_000,
    state: "analysis_retry_wait",
    failureCode: "AI_RETRY_PENDING",
    analysisAttemptCount: 3,
    analysisNextAttemptAtMs: nowMs,
    resultMessageId: fakeId(7),
    transcript: { version: 1, segments: [] },
  });

  assert.equal(await fixture.controller.runAnalysisRetryTick(), false);
  assert.equal(fixture.archive.sessions.get(id).state, "analysis_failed");
  assert.equal(fixture.archive.sessions.get(id).failureCode, "AI_RETRY_EXHAUSTED");
  assert.equal(fixture.archive.sessions.get(id).analysisNextAttemptAtMs, null);
  assert.equal(analyzerCalls, 0);
});

test("AI再試行は安全期限timerでabortしDiscord結果を残してローカルだけ削除する", async (t) => {
  const nowMs = 1_800_000_000_000;
  let publisherCalls = 0;
  let resultMessageDeleted = false;
  const fixture = controllerFixture({
    now: () => nowMs,
    analyzer: { async analyze() { return new Promise(() => {}); } },
    publisher: { async publish() { publisherCalls += 1; } },
  });
  t.after(() => clearControllerTimers(fixture.controller));
  fixture.outputChannel.messages.fetch = async () => ({
    async delete() { resultMessageDeleted = true; },
  });
  const id = "B4B4B4B4B4";
  const session = {
    id,
    sessionId: id,
    guildId: GUILD_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    expiresAtMs: nowMs + 5 * 60_000 + 20,
    state: "reanalyzing",
    analysisAttemptCount: 1,
    resultMessageId: fakeId(7),
  };
  fixture.archive.sessions.set(id, session);
  fixture.controller.registerAnalysisRetry(
    { ...session, guild: fixture.guild, outputChannel: fixture.outputChannel },
    (signal) => fixture.controller.runAnalysisAttempt(
      { ...session, guild: fixture.guild, outputChannel: fixture.outputChannel },
      { version: 1, segments: [] },
      { signal },
    ),
  );

  const deadline = Date.now() + 1_000;
  while (fixture.archive.sessions.has(id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(fixture.archive.sessions.has(id), false);
  assert.equal(resultMessageDeleted, false);
  assert.equal(publisherCalls, 0);
});

test("保持期限の5分前以降はAIを呼ばず自動再試行を終了する", async (t) => {
  const nowMs = 1_800_000_000_000;
  let analyzerCalls = 0;
  const fixture = controllerFixture({
    now: () => nowMs,
    analyzer: { async analyze() { analyzerCalls += 1; throw new Error("must not run"); } },
  });
  t.after(() => clearControllerTimers(fixture.controller));
  const id = "FEDCBA0123";
  fixture.archive.sessions.set(id, {
    id,
    sessionId: id,
    guildId: GUILD_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    expiresAtMs: nowMs + 5 * 60_000,
    state: "analysis_retry_wait",
    failureCode: "AI_RETRY_PENDING",
    analysisAttemptCount: 1,
    analysisNextAttemptAtMs: nowMs,
  });

  assert.equal(await fixture.controller.runAnalysisRetryTick(), false);
  const stored = fixture.archive.sessions.get(id);
  assert.equal(stored.state, "review_pending");
  assert.equal(stored.failureCode, "AI_RETRY_EXPIRED");
  assert.equal(stored.analysisNextAttemptAtMs, null);
  assert.equal(analyzerCalls, 0);
});

test("保持期限中のAI再試行は中断してDiscord結果を残しarchiveだけ削除する", async (t) => {
  const nowMs = 1_800_000_000_000;
  const fixture = controllerFixture({ now: () => nowMs });
  t.after(() => clearControllerTimers(fixture.controller));
  const id = "AB12CD34EF";
  let resultMessageDeleted = false;
  let retryStarted = false;
  let retryAborted = false;
  fixture.outputChannel.messages.fetch = async () => ({
    async delete() { resultMessageDeleted = true; },
  });
  const session = {
    id,
    sessionId: id,
    guildId: GUILD_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    expiresAtMs: nowMs,
    state: "reanalyzing",
    resultMessageId: fakeId(7),
  };
  fixture.archive.sessions.set(id, session);
  fixture.controller.registerAnalysisRetry(session, async (signal) => {
    retryStarted = true;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    retryAborted = true;
    return { ok: false, code: "ABORTED", aborted: true };
  });
  while (!retryStarted) await new Promise((resolve) => setImmediate(resolve));

  await fixture.controller.purgeExpiredSafely();

  assert.equal(retryAborted, true);
  assert.equal(resultMessageDeleted, false);
  assert.equal(fixture.archive.sessions.has(id), false);
  assert.equal(fixture.controller.analysisRetryTasks.has(id), false);
});

test("再起動時はBot自身の最新100件にある厳密なplaceholder markerを一意な場合だけ復旧する", async (t) => {
  const fixture = controllerFixture();
  t.after(() => clearControllerTimers(fixture.controller));
  const exactId = "C1C1C1C1C1";
  const ambiguousId = "D2D2D2D2D2";
  const missingId = "E3E3E3E3E3";
  for (const id of [exactId, ambiguousId, missingId]) {
    fixture.archive.sessions.set(id, {
      id,
      sessionId: id,
      guildId: GUILD_ID,
      outputChannelId: OUTPUT_CHANNEL_ID,
      expiresAtMs: 1_800_003_600_000,
      state: "processing_failed",
      failureCode: "PROCESS_INTERRUPTED",
      resultMessageId: null,
    });
  }
  const marker = (id) => `処理marker: \`VOICE_RESULT:${id}\``;
  const exactMessageId = fakeId(8);
  const recent = new Map([
    [exactMessageId, { id: exactMessageId, channelId: OUTPUT_CHANNEL_ID, author: { id: "bot" }, content: `前文\n${marker(exactId)}` }],
    [fakeId(9), { id: fakeId(9), channelId: OUTPUT_CHANNEL_ID, author: { id: "bot" }, content: marker(ambiguousId) }],
    [String(BigInt(fakeId(9)) + 1n), { id: String(BigInt(fakeId(9)) + 1n), channelId: OUTPUT_CHANNEL_ID, author: { id: "bot" }, content: marker(ambiguousId) }],
    [String(BigInt(fakeId(9)) + 2n), { id: String(BigInt(fakeId(9)) + 2n), channelId: OUTPUT_CHANNEL_ID, author: { id: "other" }, content: marker(missingId) }],
  ]);
  let fetchLimitCalls = 0;
  fixture.outputChannel.messages.fetch = async (options) => {
    assert.deepEqual(options, { limit: 100 });
    fetchLimitCalls += 1;
    return recent;
  };

  await fixture.controller.initialize();

  assert.equal(fetchLimitCalls, 3);
  assert.equal(fixture.archive.sessions.get(exactId).resultMessageId, exactMessageId);
  assert.equal(fixture.archive.sessions.get(exactId).failureCode, "PROCESS_INTERRUPTED");
  assert.equal(fixture.archive.sessions.get(ambiguousId).resultMessageId, null);
  assert.equal(fixture.archive.sessions.get(ambiguousId).failureCode, "RESULT_MESSAGE_RECONCILE_AMBIGUOUS");
  assert.equal(fixture.archive.sessions.get(missingId).resultMessageId, null);
  assert.equal(fixture.archive.sessions.get(missingId).failureCode, "PROCESS_INTERRUPTED");
});

test("既知の結果messageを削除できなければarchiveを消さずdeletion_failedで保持する", async (t) => {
  const fixture = controllerFixture();
  t.after(() => clearControllerTimers(fixture.controller));
  const id = "ABCDE01234";
  fixture.archive.sessions.set(id, {
    id,
    sessionId: id,
    guildId: GUILD_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    expiresAtMs: 1_800_000_060_000,
    state: "review_pending",
    resultMessageId: fakeId(7),
  });
  fixture.outputChannel.messages.fetch = async () => {
    throw Object.assign(new Error("private Discord detail"), { code: "EACCES" });
  };

  await assert.rejects(
    fixture.controller.deleteSession(id),
    (error) => error?.code === "RESULT_MESSAGE_DELETE_FAILED" && !error.message.includes("private Discord detail"),
  );
  assert.equal(fixture.archive.sessions.get(id).state, "deletion_failed");
  assert.equal(fixture.archive.sessions.get(id).failureCode, "RESULT_MESSAGE_DELETE_FAILED");
});

test("録音中の削除は文字起こしを開始せずactive音声を破棄してからarchiveを消す", async (t) => {
  let transcribeCalls = 0;
  const fixture = controllerFixture({
    transcriber: {
      async transcribeSession() {
        transcribeCalls += 1;
        return { version: 1, segments: [] };
      },
    },
  });
  t.after(() => clearControllerTimers(fixture.controller));
  const started = await fixture.controller.requestStart({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: PARTICIPANT_ID } });

  assert.equal(await fixture.controller.deleteSession(started.sessionId), true);
  assert.equal(transcribeCalls, 0);
  assert.equal(fixture.controller.session, null);
  assert.equal(fixture.controller.sessionWatchdogTimer, null);
  assert.deepEqual(fixture.receiver.calls.stop, [{ discardActive: true }]);
  assert.equal(fixture.archive.sessions.has(started.sessionId), false);
});

test("同じ録音を並行削除してもreceiver停止とarchive削除を一度だけ実行する", async (t) => {
  const fixture = controllerFixture();
  t.after(() => clearControllerTimers(fixture.controller));
  const started = await fixture.controller.requestStart({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: PARTICIPANT_ID } });
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  fixture.receiver.stop = async (options) => {
    fixture.receiver.calls.stop.push(options);
    await stopGate;
  };

  const first = fixture.controller.deleteSession(started.sessionId);
  const second = fixture.controller.deleteSession(started.sessionId);
  await new Promise((resolve) => setImmediate(resolve));
  releaseStop();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(fixture.receiver.calls.stop, [{ discardActive: true }]);
  assert.equal(fixture.archive.sessions.has(started.sessionId), false);
});

test("receiver停止に失敗した削除はarchiveとactive参照を保持し、再試行で安全に削除する", async (t) => {
  const fixture = controllerFixture();
  t.after(() => clearControllerTimers(fixture.controller));
  const started = await fixture.controller.requestStart({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: PARTICIPANT_ID } });
  let attempts = 0;
  fixture.receiver.stop = async (options) => {
    fixture.receiver.calls.stop.push(options);
    attempts += 1;
    if (attempts === 1) throw new Error("temporary stop failure");
  };

  await assert.rejects(fixture.controller.deleteSession(started.sessionId), /temporary stop failure/u);
  assert.equal(fixture.controller.session?.id, started.sessionId);
  assert.equal(fixture.controller.session?.state, "deleting");
  assert.equal(fixture.archive.sessions.has(started.sessionId), true);
  assert.equal(await fixture.controller.deleteSession(started.sessionId), true);
  assert.equal(fixture.receiver.calls.stop.length, 2);
  assert.equal(fixture.archive.sessions.has(started.sessionId), false);
});

test("active削除中のcloseは削除完了を待ちreceiverを二重停止せず最後にarchiveを閉じる", async (t) => {
  const fixture = controllerFixture();
  t.after(() => clearControllerTimers(fixture.controller));
  const started = await fixture.controller.requestStart({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: PARTICIPANT_ID } });
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  fixture.receiver.stop = async (options) => {
    fixture.receiver.calls.stop.push(options);
    await stopGate;
  };

  const deleting = fixture.controller.deleteSession(started.sessionId);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = fixture.controller.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.receiver.calls.stop.length, 1);
  releaseStop();
  await Promise.all([deleting, closing]);

  assert.deepEqual(fixture.receiver.calls.stop, [{ discardActive: true }]);
  assert.deepEqual(fixture.archive.events.slice(-2), [`delete:${started.sessionId}`, "close"]);
  assert.equal(fixture.archive.sessions.has(started.sessionId), false);
});

test("処理中の削除はworkerをabortし、失敗通知や議事録を投稿せずcleanup後にarchiveを消す", async (t) => {
  let observedSignal;
  const publisherCalls = [];
  const fixture = controllerFixture({
    transcriber: {
      async transcribeSession(_id, { signal } = {}) {
        observedSignal = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" })), { once: true });
        });
      },
    },
    publisher: { async publish(payload) { publisherCalls.push(payload); } },
  });
  t.after(() => clearControllerTimers(fixture.controller));
  const started = await fixture.controller.requestStart({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: PARTICIPANT_ID } });
  await fixture.controller.stopSession({ reason: "manual", requestedById: ACTOR_ID });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await fixture.controller.deleteSession(started.sessionId), true);
  assert.equal(observedSignal.aborted, true);
  assert.equal(publisherCalls.length, 0);
  assert.equal(fixture.archive.sessions.has(started.sessionId), false);
  assert.equal(fixture.sent.some((payload) => /自動処理に失敗/u.test(payload.content || "")), false);
  assert.equal(fixture.controller.processing.has(started.sessionId), false);
});

test("削除abort後の非ABORTED publisher errorもABORTEDを優先して安全に削除する", async (t) => {
  const logs = [];
  let publishSignal;
  const fixture = controllerFixture({
    logger: { warn() {}, error: (...values) => logs.push(values.join(" ")) },
    transcriber: { async transcribeSession() { return { version: 1, segments: [] }; } },
    publisher: {
      async publish({ signal }) {
        publishSignal = signal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throw Object.assign(new Error("private transcript body"), { code: "PUBLISH_ROLLBACK_FAILED" });
      },
    },
  });
  t.after(() => clearControllerTimers(fixture.controller));
  const started = await fixture.controller.requestStart({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: ACTOR_ID } });
  await fixture.controller.consent({ user: { id: PARTICIPANT_ID } });
  await fixture.controller.stopSession({ reason: "manual", requestedById: ACTOR_ID });
  while (!publishSignal) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await fixture.controller.deleteSession(started.sessionId), true);
  assert.equal(fixture.archive.sessions.has(started.sessionId), false);
  const combined = JSON.stringify({ logs, sent: fixture.sent });
  assert.doesNotMatch(combined, /PUBLISH_ROLLBACK_FAILED/u);
  assert.doesNotMatch(combined, /private transcript body/u);
  assert.equal(fixture.sent.some((payload) => /削除確認を完了できません/u.test(payload.content || "")), false);
});

test("disabled時のprivacy/statusは要約・Web検索・機能の無効状態を明示する", () => {
  const controller = new VoiceMeetingController({
    enabled: false,
    summaryEnabled: false,
    factCheckEnabled: false,
  });
  assert.equal(controller.statusText(), "VC文字起こし機能は無効です。");
  assert.match(controller.privacyText(), /AI要約は現在無効/u);
  assert.match(controller.privacyText(), /Web検索による裏取りは現在無効/u);
  assert.match(controller.privacyText(), /同意ボタンを待たず/u);
});

test("PC終了で中断した処理は次回起動時にDiscordの処理中表示も失敗へ更新する", async (t) => {
  const fixture = controllerFixture();
  t.after(() => clearControllerTimers(fixture.controller));
  await fixture.archive.createSession({
    sessionId: "ABCDEF1234",
    state: "processing_failed",
    failureCode: "PROCESS_INTERRUPTED",
    noticeMessageId: fakeId(7),
    voiceChannelId: VOICE_CHANNEL_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    title: "再起動された会議",
  });

  assert.equal(await fixture.controller.reconcileInterruptedNotices(), 1);
  assert.ok(fixture.edited.some((payload) => /処理に失敗/u.test(payload.content || "")));
});
