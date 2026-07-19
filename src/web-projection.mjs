import crypto from "node:crypto";

const PUBLIC_STATUSES = new Set(["active", "cancelled", "completed"]);
const RSVP_STATUSES = Object.freeze(["attending", "maybe", "declined"]);
const MAX_MEETINGS = 500;
const MIN_DATE_MS = Date.UTC(2020, 0, 1);
const MAX_DATE_MS = Date.UTC(2100, 0, 1);

function publicIdFor(meetingId, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`meeting-public-id:v1:${String(meetingId)}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

function timestampMs(value, field) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < MIN_DATE_MS || result > MAX_DATE_MS) {
    throw new TypeError(`${field} is invalid`);
  }
  return result;
}

function publicReminderMinutes(value) {
  if (!Array.isArray(value)) return [];
  const result = value
    .map(Number)
    .filter((item) => Number.isSafeInteger(item) && item >= 0 && item <= 10_080);
  return [...new Set(result)].slice(0, 12).sort((a, b) => b - a);
}

function revisionFor(meetings) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, meetings }))
    .digest("hex");
  return `sha256:${hash}`;
}

/**
 * Creates the receiver's exact, explicit allowlist projection.
 * No source object is spread into the result and titles are never read.
 */
export function buildWebProjection(snapshot, {
  publicIdSecret,
  generatedAtMs,
} = {}) {
  if (!publicIdSecret || String(publicIdSecret).length < 32) {
    throw new TypeError("publicIdSecret must contain at least 32 characters");
  }
  const generated = timestampMs(generatedAtMs, "generatedAtMs");
  const sourceMeetings = Array.isArray(snapshot?.meetings) ? snapshot.meetings.slice(-MAX_MEETINGS) : [];
  const rsvps = Array.isArray(snapshot?.rsvps) ? snapshot.rsvps : [];
  const invitees = Array.isArray(snapshot?.invitees) ? snapshot.invitees : [];
  const attendanceByMeeting = new Map();
  const inviteesByMeeting = new Map();
  const answeredInviteesByMeeting = new Map();

  for (const invitee of invitees) {
    const meetingKey = String(invitee?.meetingId ?? "");
    const userKey = String(invitee?.userId ?? "");
    if (!meetingKey || !userKey) continue;
    const members = inviteesByMeeting.get(meetingKey) ?? new Set();
    members.add(userKey);
    inviteesByMeeting.set(meetingKey, members);
  }

  for (const rsvp of rsvps) {
    if (!RSVP_STATUSES.includes(rsvp?.status)) continue;
    const meetingKey = String(rsvp?.meetingId ?? "");
    const userKey = String(rsvp?.userId ?? "");
    if (!meetingKey) continue;
    const current = attendanceByMeeting.get(meetingKey) ?? { attending: 0, maybe: 0, declined: 0 };
    current[rsvp.status] += 1;
    attendanceByMeeting.set(meetingKey, current);
    if (userKey && inviteesByMeeting.get(meetingKey)?.has(userKey)) {
      const answered = answeredInviteesByMeeting.get(meetingKey) ?? new Set();
      answered.add(userKey);
      answeredInviteesByMeeting.set(meetingKey, answered);
    }
  }

  const meetings = sourceMeetings.map((meeting) => {
    if (!meeting?.id) throw new TypeError("meeting id is missing");
    if (!PUBLIC_STATUSES.has(meeting.status)) throw new TypeError("meeting status is invalid");
    const meetingKey = String(meeting.id);
    const attendance = attendanceByMeeting.get(meetingKey) ?? { attending: 0, maybe: 0, declined: 0 };
    const invited = inviteesByMeeting.get(meetingKey)?.size ?? 0;
    const answered = answeredInviteesByMeeting.get(meetingKey)?.size ?? 0;
    const startsAtMs = timestampMs(meeting.startsAtMs, "startsAtMs");
    const endsAtMs = timestampMs(meeting.endsAtMs, "endsAtMs");
    if (endsAtMs <= startsAtMs) throw new TypeError("meeting time range is invalid");
    return {
      id: publicIdFor(meetingKey, publicIdSecret),
      startsAtMs,
      endsAtMs,
      status: meeting.status,
      reminderMinutes: publicReminderMinutes(meeting.reminderMinutes),
      urlState: String(meeting.meetingUrl ?? "").trim() ? "registered" : "missing",
      attendance: {
        attending: attendance.attending,
        maybe: attendance.maybe,
        declined: attendance.declined,
        unanswered: Math.max(0, invited - answered),
      },
    };
  });

  return {
    schemaVersion: 1,
    sourceRevision: revisionFor(meetings),
    generatedAtMs: generated,
    meetings,
  };
}
