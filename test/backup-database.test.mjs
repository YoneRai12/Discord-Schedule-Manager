import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { backupDatabase } from "../scripts/backup-database.mjs";

test("WAL稼働中のSQLiteを整合性検査付きでオンラインバックアップする", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-backup-test-"));
  let live = null;
  let restored = null;
  t.after(() => {
    try { restored?.close(); } catch {}
    try { live?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const sourcePath = path.join(root, "meetings.sqlite3");
  const outputDir = path.join(root, "backups");
  live = new DatabaseSync(sourcePath);
  live.exec("PRAGMA journal_mode = WAL; CREATE TABLE meetings(id TEXT PRIMARY KEY, title TEXT NOT NULL);");
  live.prepare("INSERT INTO meetings(id, title) VALUES (?, ?)").run("TEST0001", "非公開会議");

  const result = await backupDatabase({
    sourcePath,
    outputDir,
    now: new Date("2026-07-20T12:34:56.000Z"),
  });

  assert.equal(result.integrity, "ok");
  assert.match(path.basename(result.destinationPath), /^meetings-20260720T123456Z-[0-9a-f]{8}\.sqlite3$/u);
  assert.equal(fs.existsSync(`${result.destinationPath}-wal`), false);
  restored = new DatabaseSync(result.destinationPath, { readOnly: true });
  assert.deepEqual({ ...restored.prepare("SELECT id, title FROM meetings").get() }, {
    id: "TEST0001",
    title: "非公開会議",
  });
});
