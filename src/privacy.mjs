const URL_CANDIDATE_RE = /(?:https?:\/\/|www\.|(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com)\/)[^\s<>"'`、。！？；：）】》]+/giu;
const TRAILING_URL_PUNCTUATION_RE = /[.,!?;:、。！？；：)\]}>》】）]+$/u;
const DISCORD_MENTION_RE = /<@!?\d{16,20}>|<@&\d{16,20}>|<#\d{16,20}>/gu;
const DISCORD_ID_RE = /\b\d{16,20}\b/gu;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;

function splitTrailingPunctuation(candidate) {
  const trailing = candidate.match(TRAILING_URL_PUNCTUATION_RE)?.[0] ?? "";
  return {
    url: trailing ? candidate.slice(0, -trailing.length) : candidate,
    trailing,
  };
}

export function normalizeMeetingUrl(value) {
  let candidate = String(value ?? "").trim();
  if (!candidate) throw new Error("会議URLが空です");
  if (!/^https?:\/\//iu.test(candidate)) candidate = `https://${candidate}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("会議URLの形式が正しくありません");
  }
  if (parsed.protocol !== "https:") throw new Error("会議URLは https:// で指定してください");
  if (parsed.username || parsed.password) throw new Error("認証情報を含むURLは登録できません");
  if (!parsed.hostname.includes(".")) throw new Error("会議URLのホスト名が正しくありません");
  const normalized = parsed.toString();
  if (normalized.length > 2_048) throw new Error("会議URLが長すぎます");
  return normalized;
}

export function containsUrlLike(text) {
  URL_CANDIDATE_RE.lastIndex = 0;
  return URL_CANDIDATE_RE.test(String(text ?? ""));
}

export function assertSafeForAi(text) {
  const value = String(text ?? "");
  if (containsUrlLike(value)) throw new Error("AI送信前の本文にURLが残っています");
  if (DISCORD_MENTION_RE.test(value) || DISCORD_ID_RE.test(value)) {
    DISCORD_MENTION_RE.lastIndex = 0;
    DISCORD_ID_RE.lastIndex = 0;
    throw new Error("AI送信前の本文にDiscord識別子が残っています");
  }
  DISCORD_MENTION_RE.lastIndex = 0;
  DISCORD_ID_RE.lastIndex = 0;
}

export function extractAndRedactSensitiveText(rawText) {
  const urls = [];
  let sanitizedText = String(rawText ?? "").replace(URL_CANDIDATE_RE, (candidate) => {
    const { url, trailing } = splitTrailingPunctuation(candidate);
    try {
      urls.push(normalizeMeetingUrl(url));
    } catch {
      // URLらしい文字列は正規化できなくてもAIへ送らない。
      urls.push(url);
    }
    return `[URL_REDACTED]${trailing}`;
  });

  sanitizedText = sanitizedText
    .replace(DISCORD_MENTION_RE, "[DISCORD_MENTION]")
    .replace(DISCORD_ID_RE, "[DISCORD_ID]")
    .replace(EMAIL_RE, "[EMAIL_REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 4_000);

  assertSafeForAi(sanitizedText);
  return { sanitizedText, urls: [...new Set(urls)] };
}

export function safeDisplayText(text, maxLength = 100) {
  return String(text ?? "")
    .replace(/@everyone|@here/giu, (value) => value.replace("@", "＠"))
    .replace(DISCORD_MENTION_RE, "[メンション]")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}
