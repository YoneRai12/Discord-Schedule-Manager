import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parse } from "dotenv";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const scannableFiles = files.filter((file) => file !== "scripts/check-public-safety.mjs");
const publicText = scannableFiles.map((file) => {
  try {
    return `\n--- ${file} ---\n${fs.readFileSync(file, "utf8")}`;
  } catch {
    return "";
  }
}).join("");

const failures = [];
const isSensitiveEnvKey = (key) => {
  const normalizedKey = String(key).toUpperCase();
  const parts = normalizedKey.split("_");
  return ["TOKEN", "SECRET", "PASSWORD", "KEY", "CREDENTIAL", "CREDENTIALS"].some((part) => parts.includes(part))
    || /_(?:ID|IDS|URL|FILE|PATH)$/u.test(normalizedKey);
};
const checks = [
  ["private_context", /JAM|SSTK|Minecraft|YonerAI|YoneRai|よねらい|なつき|あやと|Natsuki/u],
  ["literal_discord_snowflake", /\b\d{16,20}\b/u],
  ["windows_user_path", /[A-Z]:\\(?:Users|AIで)/u],
  ["api_key_shape", /(?:sk-(?:proj-)?|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{8,}/u],
  ["discord_token_shape", /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}\b/u],
  ["private_key_pem", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["google_service_account_email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.iam\.gserviceaccount\.com/iu],
  ["oauth_client_secret", /"client_secret"\s*:\s*"[^"\r\n]{8,}"/u],
  ["nonempty_secret_assignment", /^(?:DISCORD_BOT_TOKEN|OPENAI_API_KEY|MEETING_WEB_SYNC_SECRET|MEETING_WEB_AUTH_TOKEN|GOOGLE_SERVICE_ACCOUNT_FILE|GOOGLE_PRIVATE_KEY)[ \t]*=[ \t]*\S+/mu],
];
for (const [name, pattern] of checks) {
  if (pattern.test(publicText)) failures.push(name);
}

if (fs.existsSync(".env")) {
  const env = parse(fs.readFileSync(".env", "utf8"));
  const localValues = Object.entries(env)
    .filter(([key]) => isSensitiveEnvKey(key))
    .map(([, value]) => String(value || "").trim())
    .filter((value) => value.length >= 6);
  if (localValues.some((value) => publicText.includes(value))) failures.push("local_env_value");
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  scannedFiles: files.length,
  failedChecks: failures,
}));
if (failures.length) process.exitCode = 1;
