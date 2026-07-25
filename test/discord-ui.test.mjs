import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectInvitePayload, buildMeetingPayload } from "../src/discord-ui.mjs";

const meeting = {
  id: "ABCD1234",
  title: "運営定例",
  startsAtMs: Date.parse("2026-07-20T11:30:00Z"),
  endsAtMs: Date.parse("2026-07-20T12:30:00Z"),
  updatedAtMs: Date.parse("2026-07-19T00:00:00Z"),
  reminderMinutes: [30, 0],
  meetingUrl: "https://meet.example.com/room",
  status: "active",
};

test("会議カードに個別招待の未回答者だけを表示する", () => {
  const payload = buildMeetingPayload(meeting, [{
    meetingId: meeting.id,
    userId: "member-a",
    displayName: "メンバーA",
    status: "attending",
  }], {
    invitees: [
      { userId: "member-a", displayName: "メンバーA" },
      { userId: "member-b", displayName: "メンバーB" },
    ],
  });
  const embed = payload.embeds[0].toJSON();
  const unanswered = embed.fields.find((field) => field.name.includes("未回答"));
  assert.equal(unanswered.value, "メンバーB");
});

test("会議カードは全体メンションではなく参加者メンションの時刻を表示する", () => {
  const payload = buildMeetingPayload(meeting, [], { attendeeMentionOffsets: [0] });
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.description, /開始時（参加者をメンション）/u);
  assert.doesNotMatch(embed.description, /@everyone/u);
});

test("個別DMには出欠ボタン・会議URL・ローカル回答の説明を付ける", () => {
  const payload = buildDirectInvitePayload(meeting);
  const embed = payload.embeds[0].toJSON();
  const buttons = payload.components[0].toJSON().components;
  assert.equal(buttons.length, 4);
  assert.equal(buttons.at(-1).url, meeting.meetingUrl);
  assert.match(embed.footer.text, /GPTへ送信されません/u);
});

test("終了済み会議はURLを隠し出欠ボタンを無効化する", () => {
  const completed = { ...meeting, status: "completed" };
  const payload = buildMeetingPayload(completed, []);
  const embed = payload.embeds[0].toJSON();
  const buttons = payload.components[0].toJSON().components;
  assert.match(embed.title, /終了/u);
  assert.equal(buttons.length, 3);
  assert.equal(buttons.every((button) => button.disabled), true);
});
