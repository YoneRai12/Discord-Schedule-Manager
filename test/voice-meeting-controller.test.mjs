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
  for (const timer of controller.processingExpiryTimers.values()) clearTimeout(timer);
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

test("録音終了の補助メッセージ送信に失敗してもローカル文字起こしを開始する", async (t) => {
  const fixture = controllerFixture({
    validateAutomaticSession: async () => true,
    failProcessingSend: true,
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

  assert.equal((await controller.stopSession({ reason: "manual", requestedById: ACTOR_ID })).stopped, true);
  await Promise.allSettled([...controller.processing.values()]);
  assert.equal(archive.sessions.get(started.sessionId).state, "review_pending");
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
    expiresAtMs: 1_800_000_060_000,
    state: "review_pending",
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

test("削除中のDiscord rollback失敗はABORTEDにせず固定codeだけを警告して成功扱いしない", async (t) => {
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

  await assert.rejects(
    fixture.controller.deleteSession(started.sessionId),
    (error) => error?.code === "PUBLISH_ROLLBACK_FAILED",
  );
  assert.equal(fixture.archive.sessions.get(started.sessionId).state, "deletion_failed");
  assert.equal(fixture.archive.sessions.has(started.sessionId), true);
  const combined = JSON.stringify({ logs, sent: fixture.sent });
  assert.match(combined, /PUBLISH_ROLLBACK_FAILED/u);
  assert.doesNotMatch(combined, /private transcript body/u);
  assert.equal(fixture.sent.some((payload) => /削除確認を完了できません/u.test(payload.content || "")), true);
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
