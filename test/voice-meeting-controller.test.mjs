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

function fakeArchive() {
  const sessions = new Map();
  const updates = [];
  return {
    sessions,
    updates,
    async initialize() {},
    async purgeExpired() { return { deleted: 0, failed: 0 }; },
    async createSession(record) {
      const stored = { ...record, consents: [] };
      sessions.set(record.sessionId, stored);
      return stored;
    },
    async getSession(id) { return sessions.get(id) || null; },
    async updateSession(id, patch) {
      updates.push({ id, patch });
      const current = sessions.get(id) || {};
      const next = { ...current, ...patch };
      if (patch.consent) next.consents = [...(current.consents || []), patch.consent];
      sessions.set(id, next);
      return sessions.get(id);
    },
    async writeTranscript(id, transcript) {
      sessions.set(id, { ...(sessions.get(id) || {}), transcript });
    },
    async writeAnalysis(id, analysis) {
      sessions.set(id, { ...(sessions.get(id) || {}), analysis });
    },
    async deleteSession(id) { sessions.delete(id); },
    async close() {},
  };
}

function fakeReceiver() {
  const calls = { start: [], pause: 0, resume: 0, stop: [], consentSets: [] };
  return {
    calls,
    async start(options) { calls.start.push(options); },
    async pause() { calls.pause += 1; },
    resume() { calls.resume += 1; },
    async stop(options) { calls.stop.push(options); },
    setConsentedUserIds(ids) { calls.consentSets.push([...ids]); },
  };
}

function buildDiscord({ everyoneViewDenied = true, invisibleMemberId = null } = {}) {
  const sent = [];
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
  };
  const memberById = new Map();
  const addMember = (id) => {
    const member = {
      id,
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
      async fetch(id) { return id === OUTPUT_CHANNEL_ID ? outputChannel : null; },
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
  const archive = fakeArchive();
  const receiver = fakeReceiver();
  const controller = new VoiceMeetingController({
    client: discord.client,
    guildId: GUILD_ID,
    outputChannelId: OUTPUT_CHANNEL_ID,
    archive,
    receiver,
    transcriber: {
      async transcribeSession() { return { language: "ja-JP", segments: [] }; },
    },
    enabled: true,
    summaryEnabled: false,
    factCheckEnabled: false,
    validateAutomaticSession: options.validateAutomaticSession,
    releaseAutomaticSession: options.releaseAutomaticSession,
    automaticValidationIntervalMs: options.automaticValidationIntervalMs,
    now: () => 1_800_000_000_000,
    logger: { warn() {}, error() {} },
  });
  return { controller, archive, receiver, ...discord };
}

function clearControllerTimers(controller) {
  clearTimeout(controller.maxTimer);
  clearInterval(controller.noticeTimer);
  clearInterval(controller.janitorTimer);
  clearInterval(controller.automaticValidationTimer);
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

test("予定の指定VCからは同意確認だけを自動開始し、入室だけでは録音しない", async (t) => {
  const fixture = controllerFixture();
  const { controller, receiver, guild, voiceChannel, sent } = fixture;
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
  assert.match(sent[0].content, /入室を検知.*同意確認を自動/u);
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
  assert.equal(await controller.confirmAutomaticPending(started.sessionId), true);

  await controller.consent({ user: { id: ACTOR_ID } });
  const result = await controller.consent({ user: { id: PARTICIPANT_ID } });

  assert.equal(result.allConsented, false);
  assert.equal(receiver.calls.start.length, 0);
  assert.equal(controller.session, null);
  assert.equal(validations.at(-1).sessionId, started.sessionId);
  assert.equal(validations.at(-1).sourceMeetingId, "MEET0001");
  assert.equal(validations.at(-1).voiceChannelId, VOICE_CHANNEL_ID);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].reason, "meeting_rescheduled");
});

test("DB finalize前の全員同意は保持だけ行いconfirm後に一度だけ録音開始する", async (t) => {
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

  const results = await Promise.all([
    controller.consent({ user: { id: ACTOR_ID } }),
    controller.consent({ user: { id: PARTICIPANT_ID } }),
  ]);
  assert.equal(results.some((result) => result.allConsented), false);
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

test("自動pending中の参加者が議事録チャンネルを見られなければ録音せず取消す", async (t) => {
  const releases = [];
  const fixture = controllerFixture({
    invisibleMemberId: NEW_PARTICIPANT_ID,
    releaseAutomaticSession: async (context) => releases.push(context),
  });
  const { controller, receiver, addMember, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  await controller.requestStartForVoiceChannel({
    guild,
    voiceChannel,
    requestedById: ACTOR_ID,
    automatic: true,
    sourceMeetingId: "MEET0001",
  });
  const newcomer = addMember(NEW_PARTICIPANT_ID);

  assert.equal(await controller.handleVoiceStateUpdate(
    { guild, channelId: null, member: newcomer },
    { guild, channelId: VOICE_CHANNEL_ID, member: newcomer },
  ), true);
  assert.equal(controller.session, null);
  assert.equal(receiver.calls.start.length, 0);
  assert.equal(releases.length, 0);
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

test("録音中に議事録チャンネルを見られない参加者が入ったらpause後に安全停止する", async (t) => {
  const fixture = controllerFixture({ invisibleMemberId: NEW_PARTICIPANT_ID });
  const { controller, receiver, addMember, guild, voiceChannel } = fixture;
  t.after(() => clearControllerTimers(controller));
  await controller.requestStart({ user: { id: ACTOR_ID } });
  await controller.consent({ user: { id: ACTOR_ID } });
  await controller.consent({ user: { id: PARTICIPANT_ID } });
  const newcomer = addMember(NEW_PARTICIPANT_ID);

  assert.equal(await controller.handleVoiceStateUpdate(
    { guild, channelId: null, member: newcomer },
    { guild, channelId: voiceChannel.id, member: newcomer },
  ), true);
  assert.equal(receiver.calls.pause, 1);
  assert.equal(receiver.calls.stop.length, 1);
  assert.equal(controller.session, null);
  await Promise.allSettled([...controller.processing.values()]);
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

test("議事録channelで@everyoneのViewChannel denyがなければ開始を拒否する", async (t) => {
  const fixture = controllerFixture({ everyoneViewDenied: false });
  const { controller, receiver, archive, sent } = fixture;
  t.after(() => clearControllerTimers(controller));
  await assert.rejects(
    controller.requestStart({ user: { id: ACTOR_ID } }),
    /@everyone.*明示的に拒否/u,
  );
  assert.equal(receiver.calls.start.length, 0);
  assert.equal(archive.sessions.size, 0);
  assert.equal(sent.length, 0);
  assert.equal(controller.session, null);
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
  assert.match(controller.privacyText(), /全員が毎回同意するまで録音しません/u);
});
