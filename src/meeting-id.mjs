import crypto from "node:crypto";

// 0/O, 1/I/L を除き、Discord上で読み違えにくい文字だけを新規IDに使う。
export const MEETING_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const MEETING_ID_LENGTH = 8;
export const LEGACY_MEETING_ID_MIN_LENGTH = 7;
const STANDALONE_ID_STOPWORDS = new Set(["CALENDAR", "DISCORD", "MEETING", "REDACTED", "REGISTER", "REMINDER"]);

export function normalizeMeetingId(value, { required = true } = {}) {
  const id = String(value ?? "").normalize("NFKC").trim().toUpperCase().replace(/^#/, "");
  if (/^[A-Z0-9]{7,8}$/u.test(id)) return id;
  if (!required) return null;
  throw new Error("会議IDは7〜8文字で指定してください");
}

export function extractMeetingId(rawText, options = {}) {
  return extractMeetingIds(rawText, options)[0] || null;
}

export function extractMeetingIds(rawText, { knownIds = [] } = {}) {
  const text = String(rawText ?? "").normalize("NFKC");
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = normalizeMeetingId(value, { required: false });
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  const labelledPattern = /(?<![A-Z0-9])(?:meeting\s*)?id\s*[:：=#()（）\[\]「」『』-]?\s*([A-Z0-9]{7,8})(?![A-Z0-9])/giu;
  for (const match of text.matchAll(labelledPattern)) add(match[1]);
  // ラベルなしはBotが表示する大文字表記だけを受ける。括弧や引用符で
  // 囲まれたIDもAIへ流さないため、ASCII英数字以外を境界として扱う。
  const standalonePattern = /(?<![A-Z0-9])([A-Z0-9]{7,8})(?![A-Z0-9])/giu;
  for (const match of text.matchAll(standalonePattern)) {
    const raw = match[1];
    const upper = raw.toUpperCase();
    // Unlabelled lower-case words are common prose. Treat them as local IDs
    // only when they contain a digit; labelled IDs above still accept letters.
    if (raw !== upper && !/\d/u.test(raw)) continue;
    if (!STANDALONE_ID_STOPWORDS.has(upper)) add(raw);
  }
  for (const value of knownIds || []) {
    const id = normalizeMeetingId(value, { required: false });
    if (!id) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`(^|[^A-Z0-9])${escaped}(?=$|[^A-Z0-9])`, "iu").test(text)) add(id);
  }
  return ids;
}

export function redactMeetingId(rawText, meetingId = extractMeetingId(rawText)) {
  return redactMeetingIds(rawText, meetingId ? [meetingId] : []);
}

export function redactMeetingIds(rawText, meetingIds = extractMeetingIds(rawText)) {
  const text = String(rawText ?? "").normalize("NFKC");
  let redacted = text;
  for (const value of meetingIds || []) {
    const id = normalizeMeetingId(value, { required: false });
    if (!id) continue;
    const pattern = new RegExp(`(^|[^A-Z0-9])${id}(?=$|[^A-Z0-9])`, "giu");
    redacted = redacted.replace(pattern, (_whole, prefix) => `${prefix}[MEETING_ID]`);
  }
  return redacted;
}

function randomMeetingId(randomBytes = crypto.randomBytes) {
  const output = [];
  while (output.length < MEETING_ID_LENGTH) {
    const bytes = randomBytes(MEETING_ID_LENGTH - output.length + 4);
    for (const byte of bytes) {
      // Rejection sampling avoids modulo bias because the alphabet is not a power of two.
      const usableRange = Math.floor(256 / MEETING_ID_ALPHABET.length) * MEETING_ID_ALPHABET.length;
      if (byte >= usableRange) continue;
      output.push(MEETING_ID_ALPHABET[byte % MEETING_ID_ALPHABET.length]);
      if (output.length === MEETING_ID_LENGTH) break;
    }
  }
  return output.join("");
}

export function generateMeetingId({ exists = () => false, randomBytes = crypto.randomBytes, maxAttempts = 32 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const id = randomMeetingId(randomBytes);
    if (!exists(id)) return id;
  }
  throw new Error("会議IDを生成できませんでした");
}
