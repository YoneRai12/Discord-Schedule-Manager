import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MeetingDatabase } from "../src/database.mjs";
import { redactMeetingId } from "../src/meeting-id.mjs";

function meetingInput(overrides = {}) {
  const startsAtMs = Date.now() + 24 * 60 * 60_000;
  return {
    guildId: "guild-example",
    channelId: "channel-example",
    createdById: "admin-example",
    createdByName: "管理者A",
    title: "定例会議",
    startsAtMs,
    endsAtMs: startsAtMs + 60 * 60_000,
    timeZone: "Asia/Tokyo",
    meetingUrl: "https://meet.example.com/room",
    reminderMinutes: [30, 0],
    everyoneOffsets: [0],
    ...overrides,
  };
}

function temporaryDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-id-compatibility-"));
  const databasePath = path.join(root, "meetings.sqlite3");
  let store = new MeetingDatabase(databasePath);
  t.after(() => {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    get store() { return store; },
    reopen() {
      store.close();
      store = new MeetingDatabase(databasePath);
      return store;
    },
  };
}

test("新規会議IDは読み違えにくいalphabetの8文字で、一意に生成する", (t) => {
  const database = temporaryDatabase(t);
  const ids = [];
  for (let index = 0; index < 128; index += 1) {
    ids.push(database.store.createMeeting(meetingInput({ title: `定例会議${index + 1}` })).id);
  }

  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.equal(id.length, 8);
    assert.match(id, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/u);
    assert.doesNotMatch(id, /[01ILO]/u);
  }
});

test("全角化された会議IDもAI送信前に伏せ字化する", () => {
  assert.equal(redactMeetingId("会議ＩＤ：ＡＢＣ１２３４"), "会議ID:[MEETING_ID]");
});

test("既存の7文字会議IDはDB再起動後も同じIDで参照・更新できる", (t) => {
  const database = temporaryDatabase(t);
  const legacyId = "ABC1234";
  const created = database.store.createMeeting(meetingInput({
    id: legacyId,
    meetingUrl: "https://meet.example.com/legacy-room",
  }));
  database.store.setMessageId(created.id, "message-example");

  const reopened = database.reopen();
  assert.equal(reopened.getMeeting(legacyId).id, legacyId);
  assert.equal(reopened.getMeeting(legacyId).messageId, "message-example");

  const updated = reopened.updateMeeting(legacyId, {
    meetingUrl: "https://meet.example.com/updated-room",
  });
  assert.equal(updated.id, legacyId);
  assert.equal(updated.meetingUrl, "https://meet.example.com/updated-room");
});
