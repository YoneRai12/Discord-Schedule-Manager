import { extractMeetingId } from "./meeting-id.mjs";

const RSVP_PATTERNS = [
  {
    status: "declined",
    pattern: /欠席|不参加|参加(?:は)?(?:できない|できません|しない|しません)|行けない|行けません|出られない|出られません|無理|都合(?:が)?(?:つかない|つきません)/u,
  },
  {
    status: "maybe",
    pattern: /未定|保留|わからない|分からない|まだ(?:不明|決められない|わからない|分からない)/u,
  },
  {
    status: "attending",
    pattern: /参加|出席|行けます|行きます|行く|出ます|出る|大丈夫|(?:^|\s)(?:ok|yes)(?:\s|$)|おっけー?/iu,
  },
];

export function parseDirectMessageRsvp(rawText) {
  const text = String(rawText ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return null;

  const meetingId = extractMeetingId(text);
  const status = RSVP_PATTERNS.find((item) => item.pattern.test(text))?.status || null;
  if (!status) return null;
  return { meetingId, status };
}
