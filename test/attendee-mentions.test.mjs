import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAttendeeMention,
  selectAttendingMentionUserIds,
} from "../src/attendee-mentions.mjs";
import { buildNotificationPayload } from "../src/discord-ui.mjs";

const discordId = (suffix) => `${"1".repeat(17)}${suffix}`;
const ATTENDING_A = discordId("1");
const ATTENDING_B = discordId("2");
const MAYBE = discordId("3");
const DECLINED = discordId("4");

const rsvps = [
  { userId: ATTENDING_A, status: "attending" },
  { userId: MAYBE, status: "maybe" },
  { userId: DECLINED, status: "declined" },
  { userId: ATTENDING_B, status: "attending" },
  { userId: ATTENDING_A, status: "attending" },
  { userId: "@everyone", status: "attending" },
];

test("参加者メンションは参加状態の有効なDiscord IDだけを重複なく選ぶ", () => {
  assert.deepEqual(selectAttendingMentionUserIds(rsvps), [ATTENDING_A, ATTENDING_B]);
  assert.deepEqual(selectAttendingMentionUserIds(rsvps, { enabled: false }), []);
});

test("参加者メンションはユーザーだけを許可し全体・ロールメンションを解析しない", () => {
  assert.deepEqual(buildAttendeeMention(rsvps), {
    content: `<@${ATTENDING_A}> <@${ATTENDING_B}>`,
    allowedMentions: { parse: [], users: [ATTENDING_A, ATTENDING_B] },
  });
});

test("参加者0人でも開始通知を送り、誰もメンションしない", () => {
  const payload = buildNotificationPayload({
    meetingId: "ABCD1234",
    offsetMinutes: 0,
    mentionAttendees: true,
    title: "運営定例",
    startsAtMs: Date.now(),
    meetingUrl: "https://meet.example.com/room",
  }, [
    { userId: MAYBE, status: "maybe" },
    { userId: DECLINED, status: "declined" },
  ]);

  assert.match(payload.content, /^📢/u);
  assert.doesNotMatch(payload.content, /<@|@everyone/u);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("メンション対象外の通知時刻では参加者がいてもメンションしない", () => {
  const payload = buildNotificationPayload({
    meetingId: "ABCD1234",
    offsetMinutes: 30,
    mentionAttendees: false,
    title: "運営定例",
    startsAtMs: Date.now() + 30 * 60_000,
    meetingUrl: "https://meet.example.com/room",
  }, rsvps);

  assert.doesNotMatch(payload.content, /<@|@everyone/u);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});
