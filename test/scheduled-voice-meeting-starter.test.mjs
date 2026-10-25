import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import { ScheduledVoiceMeetingStarter } from "../src/voice/scheduled-voice-meeting-starter.mjs";

const snowflake = (prefix) => `${prefix}${"234567890"}${"12345678"}`;
const GUILD_ID = snowflake(1);
const VOICE_CHANNEL_ID = snowflake(2);
const MEMBER_ID = snowflake(3);

function fixture({
  candidates = null,
  humanCount = 1,
  startError = null,
  finalizeResult = true,
  confirmResult = true,
  confirmError = null,
  pendingOutcome = null,
  activeSession = null,
  finalizedMeetings = [],
  archivedSessions = new Map(),
} = {}) {
  const nowMs = 1_800_000_000_000;
  const meeting = {
    id: "MEET0001",
    guildId: GUILD_ID,
    title: "全体MTG",
    startsAtMs: nowMs + 5 * 60_000,
    endsAtMs: nowMs + 65 * 60_000,
    voiceChannelId: VOICE_CHANNEL_ID,
    voiceAutoRecord: true,
    updatedAtMs: nowMs - 10_000,
  };
  const members = new Map();
  for (let index = 0; index < humanCount; index += 1) {
    const id = index === 0 ? MEMBER_ID : snowflake(index + 4);
    members.set(id, { id, user: { id, bot: false } });
  }
  const voiceChannel = {
    id: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    type: ChannelType.GuildVoice,
    members,
  };
  const guild = {
    id: GUILD_ID,
    channels: { fetch: async (id) => id === VOICE_CHANNEL_ID ? voiceChannel : null },
  };
  const calls = {
    claim: 0,
    claimOptions: [],
    finalize: 0,
    release: 0,
    releaseArgs: [],
    starts: [],
    cancels: [],
    validates: 0,
    archiveUpdates: [],
    confirms: [],
    order: [],
    outcomes: [],
  };
  let claimed = false;
  const store = {
    recoverStaleVoiceAutoClaims() { return 0; },
    listVoiceAutoStartCandidates() { return candidates || [meeting]; },
    listFinalizedVoiceAutoStarts() { return finalizedMeetings; },
    claimVoiceAutoStart(id, token, options) {
      calls.claim += 1;
      calls.claimOptions.push({ id, token, options });
      if (claimed) return false;
      claimed = true;
      return true;
    },
    finalizeVoiceAutoStart() {
      calls.order.push("finalize");
      calls.finalize += 1;
      return finalizeResult;
    },
    releaseVoiceAutoStart(...args) {
      calls.release += 1;
      calls.releaseArgs.push(args);
      claimed = false;
      return true;
    },
  };
  const controller = {
    enabled: true,
    session: activeSession,
    starting: false,
    processing: new Map(),
    async requestStartForVoiceChannel(input) {
      calls.order.push("request");
      calls.starts.push(input);
      if (startError) throw startError;
      return { sessionId: "ABCDEF0123" };
    },
    async confirmAutomaticPending(sessionId) {
      calls.order.push("confirm");
      calls.confirms.push(sessionId);
      if (confirmError) throw confirmError;
      return confirmResult;
    },
    async consumeAutomaticPendingOutcome(sessionId) {
      calls.outcomes.push(sessionId);
      return pendingOutcome;
    },
    async cancelAutomaticPending(input) { calls.cancels.push(input); return true; },
    async validateAutomaticPendingNow() { calls.validates += 1; controller.session = null; return true; },
  };
  const archive = {
    async getSession(id) { return archivedSessions.get(id) || null; },
    async updateSession(id, patch) { calls.archiveUpdates.push({ id, patch }); },
  };
  const starter = new ScheduledVoiceMeetingStarter({
    client: { guilds: { fetch: async () => guild } },
    store,
    controller,
    guildId: GUILD_ID,
    now: () => nowMs,
    archive,
    logger: { warn() {}, error() {} },
  });
  return { starter, meeting, voiceChannel, calls, nowMs };
}

test("対象時刻の指定VCに人がいれば自動で同意確認開始を一度だけ要求する", async () => {
  const { starter, meeting, calls, nowMs } = fixture();
  assert.equal(await starter.tick(), true);
  assert.equal(calls.claim, 1);
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.starts[0].voiceChannel.id, meeting.voiceChannelId);
  assert.equal(calls.starts[0].automatic, true);
  assert.equal(calls.starts[0].sourceMeetingId, meeting.id);
  assert.equal(calls.finalize, 1);
  assert.deepEqual(calls.confirms, ["ABCDEF0123"]);
  assert.deepEqual(calls.order, ["request", "finalize", "confirm"]);
  assert.equal(calls.release, 0);
  assert.deepEqual(calls.claimOptions[0].options, {
    nowMs,
    earlyMinutes: 15,
    expectedUpdatedAtMs: meeting.updatedAtMs,
    expectedVoiceChannelId: meeting.voiceChannelId,
  });
});

test("同じVC・時間帯に会議が重複した場合は誤選択せず開始しない", async () => {
  const base = fixture();
  const duplicate = { ...base.meeting, id: "MEET0002" };
  const { starter, calls } = fixture({ candidates: [base.meeting, duplicate] });
  assert.equal(await starter.tick(), false);
  assert.equal(calls.claim, 0);
  assert.equal(calls.starts.length, 0);
});

test("VCが空なら開始せず、開始前検証の失敗時はclaimを解放する", async () => {
  const empty = fixture({ humanCount: 0 });
  assert.equal(await empty.starter.tick(), false);
  assert.equal(empty.calls.claim, 0);

  const failed = fixture({ startError: new Error("output_channel_not_private") });
  assert.equal(await failed.starter.tick(), false);
  assert.equal(failed.calls.claim, 1);
  assert.equal(failed.calls.finalize, 0);
  assert.equal(failed.calls.release, 1);
});

test("Botの入室イベントは自動開始トリガーにしない", async () => {
  const { starter, calls } = fixture();
  const handled = await starter.handleVoiceStateUpdate(
    { guild: { id: GUILD_ID }, channelId: null, member: { user: { id: snowflake(9), bot: true } } },
    { guild: { id: GUILD_ID }, channelId: VOICE_CHANNEL_ID, member: { user: { id: snowflake(9), bot: true } } },
  );
  assert.equal(handled, false);
  assert.equal(calls.claim, 0);
});

test("finalizeに失敗したら自動同意確認を取り消してclaimを解放する", async () => {
  const { starter, meeting, calls } = fixture({ finalizeResult: false });
  assert.equal(await starter.tick(), false);
  assert.deepEqual(calls.cancels, [{
    expectedSessionId: "ABCDEF0123",
    reason: "claim_finalize_failed",
    retryable: true,
  }]);
  assert.equal(calls.release, 1);
  assert.equal(calls.releaseArgs[0][0], meeting.id);
  assert.equal(calls.releaseArgs[0][2].expectedVoiceChannelId, meeting.voiceChannelId);
  assert.equal(calls.confirms.length, 0);
});

test("finalize前に全員同意してもDB確定後のconfirmまで録音開始を許可しない", async () => {
  const { starter, calls } = fixture();
  assert.equal(await starter.tick(), true);
  assert.deepEqual(calls.order, ["request", "finalize", "confirm"]);
  assert.deepEqual(calls.confirms, ["ABCDEF0123"]);
});

test("confirm失敗時はpendingを取り消して確定済みsessionを解放する", async () => {
  const { starter, meeting, calls } = fixture({ confirmResult: false });
  assert.equal(await starter.tick(), false);
  assert.deepEqual(calls.cancels, [{
    expectedSessionId: "ABCDEF0123",
    reason: "automatic_start_failed",
    retryable: true,
  }]);
  assert.equal(calls.release, 1);
  assert.deepEqual(calls.releaseArgs[0], [
    meeting.id,
    "ABCDEF0123",
    { expectedVoiceChannelId: meeting.voiceChannelId },
  ]);
});

test("finalize前の明示denyは確定sessionを保持して自動再通知しない", async () => {
  const { starter, calls } = fixture({
    confirmResult: false,
    pendingOutcome: { retryable: false, reason: "consent_denied" },
  });
  assert.equal(await starter.tick(), false);
  assert.deepEqual(calls.outcomes, ["ABCDEF0123"]);
  assert.equal(calls.cancels.length, 0);
  assert.equal(calls.release, 0);
  assert.equal(calls.finalize, 1);
});

test("周期tickは既存の自動同意確認を再検証する", async () => {
  const { starter, calls } = fixture({
    candidates: [],
    activeSession: { automatic: true, state: "pending_consent" },
  });
  assert.equal(await starter.tick(), false);
  assert.equal(calls.validates, 1);
});

test("再起動時は録音を再開せず中断状態にして同じsessionだけ解放する", async () => {
  const sessionId = "ABCDEF0123";
  const base = fixture();
  const finalized = { ...base.meeting, voiceAutoSessionId: sessionId };
  const archivedSessions = new Map([[sessionId, { id: sessionId, state: "recording" }]]);
  const { starter, calls, nowMs } = fixture({
    finalizedMeetings: [finalized],
    archivedSessions,
  });
  assert.equal(await starter.recoverInterruptedAutomaticSessions(), 1);
  assert.deepEqual(calls.archiveUpdates, [{
    id: sessionId,
    patch: {
      state: "interrupted",
      stoppedAtMs: nowMs,
      stopReason: "process_restarted",
      failureCode: "process_restarted",
    },
  }]);
  assert.deepEqual(calls.releaseArgs, [[
    finalized.id,
    sessionId,
    { expectedVoiceChannelId: finalized.voiceChannelId },
  ]]);
  assert.equal(calls.starts.length, 0);
});

test("再起動時に処理中の議事録は再通知対象へ戻さない", async () => {
  const sessionId = "ABCDEF0123";
  const base = fixture();
  const finalized = { ...base.meeting, voiceAutoSessionId: sessionId };
  const { starter, calls } = fixture({
    finalizedMeetings: [finalized],
    archivedSessions: new Map([[sessionId, { id: sessionId, state: "processing" }]]),
  });
  assert.equal(await starter.recoverInterruptedAutomaticSessions(), 0);
  assert.equal(calls.release, 0);
  assert.equal(calls.archiveUpdates.length, 0);
});
