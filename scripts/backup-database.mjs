import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

function timestampForFile(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError("now must be a valid Date");
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function assertRegularSource(sourcePath) {
  const stat = fs.lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Object.assign(new Error("バックアップ元は通常のSQLiteファイルである必要があります"), {
      code: "invalid_backup_source",
    });
  }
}

export async function backupDatabase({
  sourcePath = path.resolve("data", "meetings.sqlite3"),
  outputDir = path.resolve("data", "backups"),
  now = new Date(),
} = {}) {
  const resolvedSource = path.resolve(sourcePath);
  const resolvedOutputDir = path.resolve(outputDir);
  assertRegularSource(resolvedSource);
  fs.mkdirSync(resolvedOutputDir, { recursive: true, mode: 0o700 });

  const suffix = randomBytes(4).toString("hex");
  const filename = `meetings-${timestampForFile(now)}-${suffix}.sqlite3`;
  const destinationPath = path.join(resolvedOutputDir, filename);
  const partialPath = `${destinationPath}.partial`;
  const source = new DatabaseSync(resolvedSource, { readOnly: true });
  let verification = null;
  try {
    await backup(source, partialPath);
    verification = new DatabaseSync(partialPath, { readOnly: true });
    const integrityRow = verification.prepare("PRAGMA quick_check").get();
    const integrity = String(Object.values(integrityRow || {})[0] || "unknown");
    if (integrity !== "ok") {
      throw Object.assign(new Error("SQLiteバックアップの整合性検査に失敗しました"), {
        code: "backup_integrity_failed",
      });
    }
    verification.close();
    verification = null;
    fs.renameSync(partialPath, destinationPath);
    return { destinationPath, integrity };
  } finally {
    try { verification?.close(); } catch {}
    try { source.close(); } catch {}
    if (fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true });
  }
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source" || argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} の値が必要です`);
      if (argument === "--source") result.sourcePath = value;
      else result.outputDir = value;
      index += 1;
    } else {
      throw new Error(`未対応の引数です: ${argument}`);
    }
  }
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await backupDatabase(parseArguments(process.argv.slice(2)));
    console.log(`[backup] completed path=${result.destinationPath} integrity=${result.integrity}`);
  } catch (error) {
    const code = String(error?.code || error?.name || "backup_failed").slice(0, 80);
    console.error(`[backup] failed code=${code}`);
    process.exitCode = 1;
  }
}
