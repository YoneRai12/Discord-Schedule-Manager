import { extractMeetingIds, redactMeetingIds } from "./meeting-id.mjs";

const URL_CANDIDATE_RE = /(?:https?:\/\/|www\.)[^\s<>"'`、。！？；：）】》]+|(?<![@\p{L}\p{N}_.-])(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{2,59}|[\p{L}]{2,63}))\.?(?::\d{1,5}(?!\d))?(?:[/?#\\][^\s<>"'`、。！？；：）】》]*)?/giu;
const URL_TOKEN_RE = /[^\s<>"'`、。！？；：）】》]+/gu;
const TRAILING_URL_PUNCTUATION_RE = /[.,!?;:、。！？；：)\]}>》】）]+$/u;
const DISCORD_MENTION_RE = /<@!?\d{16,20}>|<@&\d{16,20}>|<#\d{16,20}>/gu;
const DISCORD_ID_RE = /\b\d{16,20}\b/gu;
const EMAIL_RE = /[^\s<>"'`()［］【】「」『』、。！？；：,@]+@[^\s<>"'`()［］【】「」『』、。！？；：,@]+/gu;

function splitTrailingPunctuation(candidate) {
  const trailing = candidate.match(TRAILING_URL_PUNCTUATION_RE)?.[0] ?? "";
  return {
    url: trailing ? candidate.slice(0, -trailing.length) : candidate,
    trailing,
  };
}

function canonicalizeUrlDots(value) {
  return String(value ?? "")
    // WHATWG URLがdotとして扱う日本語句点類を、ASCII domain内だけ正規化する。
    .replace(/(?<=[a-z0-9-])[。．｡](?=[a-z0-9-])/giu, ".")
    // Unicode/emoji IDNはURL tailが明示された場合だけ正規化し、通常文の句点を守る。
    .replace(/(?<=[\p{L}\p{N}\p{S}-])[。．｡](?=[\p{L}\p{N}\p{S}-]{2,63}(?::\d+)?[/?#\\])/gu, ".");
}

function isSuspiciousUrlToken(candidate) {
  const value = String(candidate ?? "");
  if (/^\[[^\]\s]+\](?::\d+)?(?:[/?#\\\u2215\u2044]|%(?:2f|5c|3f|23))/iu.test(value)) {
    return true;
  }
  const tailIndex = value.search(/(?::\d|[/?#\\\u2215\u2044]|%(?:2f|5c|3f|23))/iu);
  if (tailIndex < 0) return false;
  const host = value.slice(0, tailIndex);
  return /[.。．｡]/u.test(host)
    || /^(?:0x[0-9a-f]+|\d{7,})$/iu.test(host);
}

function isPotentialResidualUrlToken(candidate) {
  const value = String(candidate ?? "");
  return /^(?:https?:\/\/|www\.)/iu.test(value)
    || /^\[[^\]\s]+\](?::\d+)?(?:[/?#\\\u2215\u2044]|%(?:2f|5c|3f|23))/iu.test(value)
    || value.includes(".")
    || isSuspiciousUrlToken(value)
    || /^(?:[a-z0-9-]+[。．｡])+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})\.?$/iu.test(value);
}

function collapseRedactedUrlTail(candidate) {
  const marker = "[URL_REDACTED]";
  const markerIndex = candidate.indexOf(marker);
  if (markerIndex < 0) return candidate;
  const prefix = candidate.slice(0, markerIndex);
  const suffix = candidate.slice(markerIndex + marker.length);
  const trailingOnly = suffix.match(TRAILING_URL_PUNCTUATION_RE)?.[0] === suffix;
  if (!suffix || trailingOnly) return candidate;
  // domainだけが一次走査で伏せられた可能性があるため、空白なしで
  // markerへ連結した残りは文字種に依存せず全て同じURLの一部として捨てる。
  return `${prefix}${marker}`;
}

export function normalizeMeetingUrl(value) {
  let candidate = String(value ?? "").trim();
  if (!candidate) throw new Error("会議URLが空です");
  if (!/^https?:\/\//iu.test(candidate)) candidate = `https://${candidate}`;

  // WHATWG URLは127.1、整数・16進・8進表記のIPv4まで正規化する。
  // 日付等の誤認を避け、数値ホストは通常の4区切りだけを受理する。
  const rawAuthority = candidate.match(/^https?:\/\/([^/?#\\]+)/iu)?.[1] ?? "";
  const rawHostWithPort = rawAuthority.includes("@")
    ? rawAuthority.slice(rawAuthority.lastIndexOf("@") + 1)
    : rawAuthority;
  const rawHost = rawHostWithPort.replace(/:\d{1,5}$/u, "").replace(/\.$/u, "");
  let canonicalIpv4 = false;
  if (/^(?:0x[0-9a-f]+|[0-9.]+)$/iu.test(rawHost)) {
    const octets = rawHost.split(".");
    canonicalIpv4 = octets.length === 4
      && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255);
    if (!canonicalIpv4) throw new Error("会議URLのホスト名が正しくありません");
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("会議URLの形式が正しくありません");
  }
  if (parsed.protocol !== "https:") throw new Error("会議URLは https:// で指定してください");
  if (parsed.username || parsed.password) throw new Error("認証情報を含むURLは登録できません");
  const hostname = parsed.hostname.replace(/\.$/u, "").toLowerCase();
  if (!hostname.includes(".")) throw new Error("会議URLのホスト名が正しくありません");
  if (!canonicalIpv4) {
    const labels = hostname.split(".");
    if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
      throw new Error("会議URLのホスト名が正しくありません");
    }
    const topLevel = labels.at(-1) ?? "";
    if (!/^xn--[a-z0-9-]{2,59}$/u.test(topLevel) && !/^[a-z]{2,63}$/u.test(topLevel)) {
      throw new Error("会議URLのホスト名が正しくありません");
    }
  }
  const normalized = parsed.toString();
  if (normalized.length > 2_048) throw new Error("会議URLが長すぎます");
  return normalized;
}

export function containsUrlLike(text) {
  URL_CANDIDATE_RE.lastIndex = 0;
  const value = canonicalizeUrlDots(String(text ?? "").normalize("NFKC"));
  if (URL_CANDIDATE_RE.test(value)) return true;
  URL_TOKEN_RE.lastIndex = 0;
  for (const match of value.matchAll(URL_TOKEN_RE)) {
    const rawToken = match[0];
    if (rawToken.includes("[URL_REDACTED]")) {
      if (collapseRedactedUrlTail(rawToken) !== rawToken) return true;
      continue;
    }
    const token = splitTrailingPunctuation(rawToken).url;
    if (!token) continue;
    if (!isPotentialResidualUrlToken(token)) continue;
    try {
      normalizeMeetingUrl(token);
      return true;
    } catch {
      // 正規化を拒否したURL風tokenにもsecret pathが含まれ得る。
      if (isSuspiciousUrlToken(token)) return true;
    }
  }
  return false;
}

export function assertSafeForAi(text) {
  const value = String(text ?? "").normalize("NFKC");
  if (containsUrlLike(value)) throw new Error("AI送信前の本文にURLが残っています");
  if (DISCORD_MENTION_RE.test(value) || DISCORD_ID_RE.test(value)) {
    DISCORD_MENTION_RE.lastIndex = 0;
    DISCORD_ID_RE.lastIndex = 0;
    throw new Error("AI送信前の本文にDiscord識別子が残っています");
  }
  DISCORD_MENTION_RE.lastIndex = 0;
  DISCORD_ID_RE.lastIndex = 0;
  EMAIL_RE.lastIndex = 0;
  if (EMAIL_RE.test(value)) {
    EMAIL_RE.lastIndex = 0;
    throw new Error("AI送信前の本文にメールアドレスが残っています");
  }
  EMAIL_RE.lastIndex = 0;
  const withoutLocalPlaceholders = value.replace(
    /\[(?:URL_REDACTED|DISCORD_MENTION|DISCORD_ID|EMAIL_REDACTED|MEMBERS_REDACTED|MEMBER_REDACTED|ATTENDANCE_TEMPLATE_REDACTED|MEETING_ID)\]/gu,
    " ",
  );
  if (extractMeetingIds(withoutLocalPlaceholders).length) {
    throw new Error("AI送信前の本文に会議IDが残っています");
  }
}

export function extractAndRedactSensitiveText(rawText) {
  const urls = [];
  let sanitizedText = canonicalizeUrlDots(String(rawText ?? "").normalize("NFKC")).replace(URL_CANDIDATE_RE, (candidate) => {
    const { url, trailing } = splitTrailingPunctuation(candidate);
    try {
      urls.push(normalizeMeetingUrl(url));
    } catch {
      // URLらしい文字列は正規化できなくてもAIへ送らない。
      urls.push(url);
    }
    return `[URL_REDACTED]${trailing}`;
  });

  // 一次regexが扱わないWHATWG互換表記・IDN・不正ラベルも二次走査する。
  // 正規化できないURL風tokenも本文ごと伏せ、共有AIへのsecret path残留を防ぐ。
  sanitizedText = sanitizedText.replace(URL_TOKEN_RE, (candidate) => {
    if (candidate.includes("[URL_REDACTED]")) return collapseRedactedUrlTail(candidate);
    const { url, trailing } = splitTrailingPunctuation(candidate);
    let shouldRedact = false;
    if (isPotentialResidualUrlToken(url)) {
      try {
        urls.push(normalizeMeetingUrl(url));
        shouldRedact = true;
      } catch {
        shouldRedact = isSuspiciousUrlToken(url);
      }
    }
    return shouldRedact ? `[URL_REDACTED]${trailing}` : candidate;
  });

  sanitizedText = sanitizedText
    .replace(DISCORD_MENTION_RE, "[DISCORD_MENTION]")
    .replace(DISCORD_ID_RE, "[DISCORD_ID]")
    .replace(EMAIL_RE, "[EMAIL_REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 4_000);

  // Meeting IDs are local routing keys.  Protect our own placeholders, redact
  // every recognized ID, then restore the placeholders before the final gate.
  // This avoids treating the word "MENTION" inside [DISCORD_MENTION] as a
  // legacy seven-character meeting ID.
  const localPlaceholders = [];
  sanitizedText = sanitizedText.replace(
    /\[(?:URL_REDACTED|DISCORD_MENTION|DISCORD_ID|EMAIL_REDACTED|MEMBERS_REDACTED|MEMBER_REDACTED|ATTENDANCE_TEMPLATE_REDACTED|MEETING_ID)\]/gu,
    (placeholder) => {
      const index = localPlaceholders.push(placeholder) - 1;
      return `\uE000${index}\uE001`;
    },
  );
  sanitizedText = redactMeetingIds(sanitizedText).replace(/\uE000(\d+)\uE001/gu, (_whole, index) => (
    localPlaceholders[Number(index)] ?? ""
  ));

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
