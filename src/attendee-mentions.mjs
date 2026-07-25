const DISCORD_SNOWFLAKE_RE = /^\d{16,20}$/u;

// 参加者テンプレートの上限と揃え、Discord本文の2,000文字上限にも余白を残す。
export const MAX_ATTENDEE_MENTIONS = 50;

/**
 * 現在「参加」のRSVPだけから、安全にDiscordメンションへ使えるIDを返す。
 * 許可リストは保存済みDiscord IDだけで作り、会議名・表示名・AI出力は使わない。
 */
export function selectAttendingMentionUserIds(
  rsvps,
  { enabled = true, limit = MAX_ATTENDEE_MENTIONS } = {},
) {
  if (!enabled) return [];
  const safeLimit = Math.max(0, Math.min(MAX_ATTENDEE_MENTIONS, Number(limit) || 0));
  if (safeLimit === 0) return [];

  const seen = new Set();
  const userIds = [];
  for (const rsvp of Array.isArray(rsvps) ? rsvps : []) {
    if (rsvp?.status !== "attending") continue;
    const userId = String(rsvp.userId ?? "").trim();
    if (!DISCORD_SNOWFLAKE_RE.test(userId) || seen.has(userId)) continue;
    seen.add(userId);
    userIds.push(userId);
    if (userIds.length >= safeLimit) break;
  }
  return userIds;
}

export function buildAttendeeMention(rsvps, options = {}) {
  const userIds = selectAttendingMentionUserIds(rsvps, options);
  return {
    content: userIds.map((userId) => `<@${userId}>`).join(" "),
    allowedMentions: userIds.length
      ? { parse: [], users: userIds }
      : { parse: [] },
  };
}
