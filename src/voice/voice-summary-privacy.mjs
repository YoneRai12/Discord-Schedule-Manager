import { extractAndRedactSensitiveText } from "../privacy.mjs";
import { extractMeetingIds } from "../meeting-id.mjs";

const MAX_SEGMENTS = 20_000;
const MAX_SEGMENT_TEXT_CHARS = 4_000;
const MAX_TRANSCRIPT_CHARS = 1_000_000;
const MAX_PUBLIC_CLAIM_CHARS = 240;

const PHONE_RE = /(?<![\p{L}\p{N}])(?:\+?\d[\d\s().-]{7,}\d)(?![\p{L}\p{N}])/gu;
const DISCORD_MARKUP_RE = /<@!?\d{16,20}>|<@&\d{16,20}>|<#\d{16,20}>/gu;
const DISCORD_ID_RE = /(?<!\d)\d{16,20}(?!\d)/gu;
const EMAIL_RE = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?<![\p{L}\p{N}@])(?:[\p{L}\p{N}-]+\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?:[/:?#][^\s<>"'`]*)?/giu;
const SECRET_RE = /(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|authorization|bearer|password|passwd|private[-_ ]?key|webhook)\s*[:=]|\b(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{8,}\b/iu;
const PATH_RE = /(?:[a-z]:\\|\\\\|\/(?:home|users?|var|etc|opt|srv|tmp)\/)[^\s<>"'`]+/iu;
const SPEAKER_TOKEN_RE = /\bspeaker-\d{2,5}\b/giu;

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeNameList(names) {
  if (!Array.isArray(names)) throw codedError("knownNames は配列で指定してください", "invalid_known_names");
  const unique = new Set();
  for (const value of names) {
    const name = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!name || name.length > 100) continue;
    unique.add(name);
  }
  return [...unique].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function redactNames(text, names) {
  let output = text;
  for (const name of names) {
    output = output.replace(new RegExp(escapeRegExp(name), "giu"), "[NAME_REDACTED]");
  }
  return output;
}

function sanitizeSegmentText(rawText, names) {
  if (typeof rawText !== "string") throw codedError("文字起こしsegmentのtextが不正です", "invalid_transcript_segment");
  if (rawText.length > MAX_SEGMENT_TEXT_CHARS) {
    throw codedError("文字起こしsegmentが大きすぎます", "transcript_segment_too_large");
  }
  const locallyRedacted = extractAndRedactSensitiveText(rawText).sanitizedText
    .replace(PHONE_RE, "[PHONE_REDACTED]")
    .replace(DISCORD_MARKUP_RE, "[DISCORD_REDACTED]")
    .replace(DISCORD_ID_RE, "[DISCORD_ID]")
    .replace(EMAIL_RE, "[EMAIL_REDACTED]")
    .replace(URL_RE, "[URL_REDACTED]");
  return redactNames(locallyRedacted, names)
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_SEGMENT_TEXT_CHARS);
}

function validateTime(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 7 * 24 * 60 * 60 * 1_000) {
    throw codedError(`文字起こしsegmentの${field}が不正です`, "invalid_transcript_segment");
  }
  return value;
}

/**
 * AIへ送る前のローカル境界。入力話者ID・登録名は一切返さず、安定した匿名tokenだけを返す。
 */
export function sanitizeVoiceTranscript(transcript, { knownNames = [] } = {}) {
  if (!transcript || typeof transcript !== "object" || Array.isArray(transcript)) {
    throw codedError("transcriptが不正です", "invalid_transcript");
  }
  if (!Array.isArray(transcript.segments) || transcript.segments.length > MAX_SEGMENTS) {
    throw codedError("transcript.segmentsが不正です", "invalid_transcript");
  }

  const suppliedNames = knownNames == null ? [] : knownNames;
  if (!Array.isArray(suppliedNames)) throw codedError("knownNames は配列で指定してください", "invalid_known_names");
  const transcriptNames = transcript.segments.map((segment) => segment?.speakerName);
  const names = normalizeNameList([...suppliedNames, ...transcriptNames]);
  const speakerTokens = new Map();
  let totalChars = 0;
  const segments = transcript.segments.map((segment, index) => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      throw codedError("文字起こしsegmentが不正です", "invalid_transcript_segment");
    }
    if (
      (segment.speakerId != null && !["string", "number", "bigint"].includes(typeof segment.speakerId))
      || String(segment.speakerId ?? "").length > 200
      || (segment.speakerName != null && typeof segment.speakerName !== "string")
      || String(segment.speakerName ?? "").length > 100
      || (segment.speaker != null && typeof segment.speaker !== "string")
      || String(segment.speaker ?? "").length > 100
    ) {
      throw codedError("文字起こしsegmentの話者情報が不正です", "invalid_transcript_segment");
    }
    const rawSpeakerKey = String(segment.speakerId ?? segment.speakerName ?? segment.speaker ?? `anonymous-${index}`);
    let speaker = speakerTokens.get(rawSpeakerKey);
    if (!speaker) {
      speaker = `speaker-${String(speakerTokens.size + 1).padStart(2, "0")}`;
      speakerTokens.set(rawSpeakerKey, speaker);
    }
    const startMs = validateTime(segment.startMs, "startMs");
    const endMs = validateTime(segment.endMs, "endMs");
    if (endMs < startMs) throw codedError("文字起こしsegmentの時刻順が不正です", "invalid_transcript_segment");
    const text = sanitizeSegmentText(segment.text, names);
    totalChars += text.length;
    if (totalChars > MAX_TRANSCRIPT_CHARS) {
      throw codedError("transcriptが大きすぎます", "transcript_too_large");
    }
    return { speaker, startMs, endMs, text };
  });

  const language = typeof transcript.language === "string"
    ? transcript.language.normalize("NFKC").replace(/[^a-z0-9-]/giu, "").slice(0, 35)
    : "";
  return { segments, ...(language ? { language } : {}) };
}

export function speakerTokensInTranscript(transcript) {
  return new Set((transcript?.segments || []).map((segment) => segment.speaker));
}

export function assertKnownSpeakerTokens(value, allowedTokens) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const found = text.match(SPEAKER_TOKEN_RE) || [];
  for (const token of found) {
    if (!allowedTokens.has(token.toLowerCase())) {
      throw codedError("AI出力に未知のspeaker tokenが含まれています", "unknown_speaker_token");
    }
  }
}

export function assertSafeSummaryOutput(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const matches = (pattern) => {
    pattern.lastIndex = 0;
    const result = pattern.test(text);
    pattern.lastIndex = 0;
    return result;
  };
  if (
    matches(DISCORD_MARKUP_RE)
    || matches(DISCORD_ID_RE)
    || matches(EMAIL_RE)
    || matches(PHONE_RE)
    || matches(URL_RE)
    || matches(SECRET_RE)
    || matches(PATH_RE)
    || extractMeetingIds(text).length > 0
  ) {
    throw codedError("AI出力に公開できない識別子または秘密情報が含まれています", "unsafe_summary_output");
  }
}

export function isSafePublicClaim(value) {
  if (typeof value !== "string") return false;
  const claim = value.normalize("NFKC").trim();
  if (!claim || claim.length > MAX_PUBLIC_CLAIM_CHARS) return false;
  const matches = (pattern) => {
    pattern.lastIndex = 0;
    const result = pattern.test(claim);
    pattern.lastIndex = 0;
    return result;
  };
  if (
    matches(DISCORD_MARKUP_RE)
    || matches(DISCORD_ID_RE)
    || matches(EMAIL_RE)
    || matches(PHONE_RE)
    || matches(URL_RE)
    || matches(SECRET_RE)
    || matches(PATH_RE)
    || matches(SPEAKER_TOKEN_RE)
  ) return false;
  return !/\[(?:NAME|URL|EMAIL|PHONE|DISCORD|MEETING_ID)[^\]]*\]/iu.test(claim);
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

export function normalizePublicSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) {
    throw codedError("出典URLが不正です", "unsafe_source_url");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw codedError("出典URLが不正です", "unsafe_source_url");
  }
  const hostname = parsed.hostname.replace(/\.$/u, "").toLowerCase();
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || !hostname.includes(".")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || isPrivateIpv4(hostname)
    || hostname.includes(":")
  ) {
    throw codedError("出典URLは公開HTTPSホストである必要があります", "unsafe_source_url");
  }
  return parsed.toString();
}
