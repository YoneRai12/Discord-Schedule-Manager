import { extractMeetingId } from "./meeting-id.mjs";

const RECENT_CREATOR_WINDOW_MS = 30 * 60_000;
const RECENT_CREATOR_SEPARATION_MS = 5 * 60_000;

function normalizedTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function safeCandidate(meeting) {
  return {
    id: meeting.id,
    title: meeting.title,
    startsAtMs: meeting.startsAtMs,
  };
}

function ambiguous(meetings, reason) {
  return {
    status: "ambiguous",
    reason,
    candidates: meetings.slice(0, 10).map(safeCandidate),
  };
}

/** Resolves a meeting locally. No text or identifier is sent to an AI service. */
export class MeetingTargetResolver {
  constructor({ store }) {
    this.store = store;
  }

  resolve({
    guildId,
    channelId,
    authorId,
    rawText = "",
    replyMessageId = null,
    nowMs = Date.now(),
  }) {
    const tenantId = String(guildId);
    const explicitId = extractMeetingId(rawText);
    if (explicitId) {
      const meeting = this.store.getMeeting(explicitId);
      return meeting?.guildId === tenantId && meeting.status === "active"
        ? { status: "resolved", via: "explicit_id", meeting }
        : { status: "not_found", reason: "explicit_id", candidates: [] };
    }

    if (replyMessageId) {
      const meeting = this.store.getMeetingByMessageId(tenantId, channelId, replyMessageId);
      if (meeting) {
        return meeting.status === "active"
          ? { status: "resolved", via: "reply", meeting }
          : { status: "not_found", reason: "reply_inactive", candidates: [] };
      }
    }

    const text = normalizedTitle(rawText);
    const titleMatches = this.store.listUpcoming(tenantId, { limit: 100, nowMs })
      .map((meeting) => ({ meeting, title: normalizedTitle(meeting.title) }))
      .filter((item) => item.title.length >= 2 && text.includes(item.title));
    if (titleMatches.length) {
      const longest = Math.max(...titleMatches.map((item) => item.title.length));
      const mostSpecific = titleMatches.filter((item) => item.title.length === longest).map((item) => item.meeting);
      if (mostSpecific.length === 1) return { status: "resolved", via: "title", meeting: mostSpecific[0] };
      return ambiguous(mostSpecific, "title");
    }

    if (channelId && authorId) {
      const recent = this.store.listRecentActiveMeetingsByCreator(
        tenantId,
        channelId,
        authorId,
        { limit: 2, nowMs },
      );
      if (recent.length) {
        const latestAgeMs = nowMs - recent[0].createdAtMs;
        const clearlyLatest = recent.length === 1
          || recent[0].createdAtMs - recent[1].createdAtMs >= RECENT_CREATOR_SEPARATION_MS;
        if (latestAgeMs >= 0 && latestAgeMs <= RECENT_CREATOR_WINDOW_MS && clearlyLatest) {
          return { status: "resolved", via: "recent_creator", meeting: recent[0] };
        }
      }
    }

    if (channelId) {
      const channelMeetings = this.store.listActiveMeetingsByChannel(tenantId, channelId, { limit: 10, nowMs });
      if (channelMeetings.length === 1) {
        return { status: "resolved", via: "single_channel_meeting", meeting: channelMeetings[0] };
      }
      if (channelMeetings.length > 1) return ambiguous(channelMeetings, "channel");
    }

    return { status: "not_found", reason: "no_candidate", candidates: [] };
  }
}
