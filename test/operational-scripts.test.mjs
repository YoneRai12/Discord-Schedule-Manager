import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows PowerShell 5.1向けスクリプトをBOM付きUTF-8で保存する", () => {
  for (const relativePath of ["start.ps1", "scripts/manage-autostart.ps1"]) {
    const bytes = fs.readFileSync(path.join(projectRoot, relativePath));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], relativePath);
  }
});

test("自動起動管理は既定で確認のみ、置換と解除は明示操作にする", () => {
  const script = fs.readFileSync(path.join(projectRoot, "scripts/manage-autostart.ps1"), "utf8");
  assert.match(script, /\[string\]\$Action = "Verify"/u);
  assert.match(script, /-not \$Replace/u);
  assert.match(script, /-not \$ConfirmRemoval/u);
  assert.match(script, /-ExecutionPolicy RemoteSigned/u);
  assert.match(script, /Resolve-AccountSid/u);
  assert.match(script, /CurrentUserSid/u);
  assert.doesNotMatch(script, /DISCORD_BOT_TOKEN\s*=/u);
});

test("package descriptionは文字化けしていない公開テンプレート説明にする", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.description,
    "自然言語、参加者テンプレート、個人別通知、出欠集計、Google Sheets同期に対応した予定管理Discord Bot",
  );
  assert.doesNotMatch(packageJson.description, /�|繧|縺/u);
});
