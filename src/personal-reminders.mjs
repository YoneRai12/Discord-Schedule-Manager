import { reminderLabel } from "./time.mjs";

const MAX_PERSONAL_REMINDERS = 6;
const MAX_OFFSET_MINUTES = 10_080;

export function normalizePersonalReminderMinutes(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_OFFSET_MINUTES))]
    .slice(0, MAX_PERSONAL_REMINDERS)
    .sort((a, b) => b - a);
}

function extractOffsets(text) {
  const offsets = [];
  const pattern = /(\d+)\s*日(?:と\s*(\d+)\s*時間)?前|(\d+)\s*時間\s*半前|(\d+)\s*時間(?:と|\s)*(\d+)\s*分前|(\d+)\s*時間前|(\d+)\s*分前|開始時/gu;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) offsets.push(Number(match[1]) * 1_440 + Number(match[2] || 0) * 60);
    else if (match[3]) offsets.push(Number(match[3]) * 60 + 30);
    else if (match[4]) offsets.push(Number(match[4]) * 60 + Number(match[5]));
    else if (match[6]) offsets.push(Number(match[6]) * 60);
    else if (match[7]) offsets.push(Number(match[7]));
    else offsets.push(0);
  }
  return normalizePersonalReminderMinutes(offsets);
}

export function parsePersonalReminderRequest(rawText) {
  const text = String(rawText ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return null;

  const hasReminderWord = /通知|リマインド|リマインダー|知らせ/u.test(text);
  const disable = /(?:通知|リマインド|知らせ)(?:は|を)?\s*(?:なし|不要|いらない|止めて|オフ)/u.test(text);
  if (disable) {
    return {
      minutes: [],
      scope: /今回|この会議だけ|今回だけ/u.test(text)
        ? "current"
        : /今後|毎回|いつも/u.test(text) ? "default" : "default_and_current",
      needsClarification: false,
    };
  }

  const minutes = extractOffsets(text);
  if (!minutes.length) {
    return hasReminderWord ? { minutes: [], scope: "current", needsClarification: true } : null;
  }
  return {
    minutes,
    scope: /今回|この会議だけ|今回だけ/u.test(text)
      ? "current"
      : /今後|毎回|いつも/u.test(text) ? "default" : "default_and_current",
    needsClarification: false,
  };
}

export function formatPersonalReminderMinutes(minutes) {
  const normalized = normalizePersonalReminderMinutes(minutes);
  return normalized.length ? normalized.map(reminderLabel).join("、") : "個別通知なし";
}
