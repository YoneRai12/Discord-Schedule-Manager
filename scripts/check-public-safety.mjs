import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parse } from "dotenv";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const scannableFiles = files.filter((file) => file !== "scripts/check-public-safety.mjs");
const stagedText = scannableFiles.map((file) => {
  const content = execFileSync("git", ["show", `:${file}`], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return `\n--- ${file} ---\n${content}`;
}).join("");

const failures = [];
const checks = [
  ["private_context", /JAM|SSTK|Minecraft|YonerAI|YoneRai|よねらい|なつき|あやと|Natsuki/u],
  ["literal_discord_snowflake", /\b\d{16,20}\b/u],
  ["windows_user_path", /[A-Z]:\\(?:Users|AIで)/u],
  ["api_key_shape", /(?:sk-(?:proj-)?|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{8,}/u],
  ["discord_token_shape", /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}\b/u],
  ["nonempty_token_assignment", /^(?:DISCORD_BOT_TOKEN|OPENAI_API_KEY)[ \t]*=[ \t]*\S+/mu],
];
for (const [name, pattern] of checks) {
  if (pattern.test(stagedText)) failures.push(name);
}

if (fs.existsSync(".env")) {
  const env = parse(fs.readFileSync(".env", "utf8"));
  const localValues = [
    env.DISCORD_BOT_TOKEN,
    env.DISCORD_GUILD_ID,
    env.OPENAI_API_KEY,
    env.GOOGLE_SHEETS_SPREADSHEET_ID,
  ].map((value) => String(value || "").trim()).filter((value) => value.length >= 6);
  if (localValues.some((value) => stagedText.includes(value))) failures.push("local_env_value");
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  stagedFiles: files.length,
  failedChecks: failures,
}));
if (failures.length) process.exitCode = 1;
