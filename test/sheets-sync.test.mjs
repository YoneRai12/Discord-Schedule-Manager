import assert from "node:assert/strict";
import test from "node:test";
import { buildSheetTables, GoogleSheetsSync } from "../src/sheets-sync.mjs";

const snapshot = {
  meetings: [{
    id: "ABCD1234",
    title: "=IMPORTXML(\"https://bad.example\")",
    startsAtMs: Date.parse("2026-07-20T11:30:00Z"),
    endsAtMs: Date.parse("2026-07-20T12:30:00Z"),
    status: "active",
    createdByName: "管理者A",
    reminderMinutes: [30, 0],
    meetingUrl: "https://meet.example.com/room",
  }],
  rsvps: [{
    meetingId: "ABCD1234",
    displayName: "メンバーA",
    status: "attending",
    updatedAtMs: Date.parse("2026-07-18T10:00:00Z"),
  }],
  deliveries: [{
    meetingId: "ABCD1234",
    offsetMinutes: 0,
    status: "pending",
    sentAtMs: null,
  }],
};

test("Sheetsには既定で会議URLを同期しない", () => {
  const tables = buildSheetTables(snapshot, { syncUrls: false });
  assert.equal(tables["会議一覧"][1][7], "登録済み（Discordで確認）");
  assert.equal(JSON.stringify(tables).includes("meet.example.com"), false);
});

test("明示設定した場合だけSheetsへ会議URLを同期する", () => {
  const tables = buildSheetTables(snapshot, { syncUrls: true });
  assert.equal(tables["会議一覧"][1][7], "https://meet.example.com/room");
});

test("値はUSER_ENTEREDではなくRAWで同期して数式注入を防ぐ", async () => {
  const calls = [];
  const sync = new GoogleSheetsSync({
    spreadsheetId: "sheet-id",
    keyFile: "unused.json",
    syncUrls: false,
    store: { getSnapshot: () => snapshot },
  });
  sync.api = {
    spreadsheets: {
      values: {
        batchUpdate: async (request) => { calls.push(["update", request]); },
        batchClear: async (request) => { calls.push(["clear", request]); },
      },
    },
  };
  await sync.sync();
  assert.equal(calls[0][1].requestBody.valueInputOption, "RAW");
  assert.equal(calls[0][1].requestBody.data.length, 3);
  assert.equal(calls[1][0], "clear");
});
