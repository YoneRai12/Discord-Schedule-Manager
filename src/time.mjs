const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;

export function parseJstDateTime(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("日時が空です");

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) {
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed)) throw new Error("日時を解釈できませんでした");
    return parsed;
  }

  const match = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})$/u);
  if (!match) throw new Error("日時は 2026-07-20 20:30 の形式で指定してください");
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error("日時の範囲が正しくありません");
  }
  const result = Date.UTC(year, month - 1, day, hour, minute) - JST_OFFSET_MS;
  const roundTrip = new Date(result + JST_OFFSET_MS);
  if (
    roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() + 1 !== month
    || roundTrip.getUTCDate() !== day
    || roundTrip.getUTCHours() !== hour
    || roundTrip.getUTCMinutes() !== minute
  ) {
    throw new Error("存在しない日時です");
  }
  return result;
}
export function discordTimestamp(milliseconds, style = "F") {
  return `<t:${Math.floor(Number(milliseconds) / 1_000)}:${style}>`;
}

export function formatJst(milliseconds) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(Number(milliseconds)));
}

export function normalizeReminderMinutes(values, fallback = [30, 0]) {
  const source = Array.isArray(values) ? values : fallback;
  const normalized = source
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_080);
  const unique = [...new Set(normalized)].slice(0, 12).sort((a, b) => b - a);
  return unique.length ? unique : [...fallback];
}

export function reminderLabel(minutes) {
  if (minutes === 0) return "開始時";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}日前`;
  if (minutes % 60 === 0) return `${minutes / 60}時間前`;
  return `${minutes}分前`;
}
