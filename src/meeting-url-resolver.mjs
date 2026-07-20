const CALENDAR_HOSTS = new Set(["calendar.app.google", "calendar.google.com"]);
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MEETING_URL_RE = /https:\/\/(?:meet\.google\.com|(?:[a-z0-9-]+\.)?zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com)\/[^\s<>"'`\\]+/giu;
const TRAILING_PUNCTUATION_RE = /[.,!?;:、。！？；：)\]}>》】）]+$/u;

const ERROR_MESSAGES = {
  invalid_url: "招待URLの形式が正しくありません。",
  https_required: "招待URLは https:// で指定してください。",
  credentials_rejected: "認証情報を含む招待URLは使用できません。",
  host_not_allowed: "この招待URLのホストにはアクセスできません。",
  fetch_failed: "招待URLを取得できませんでした。",
  timeout: "招待URLの取得がタイムアウトしました。",
  too_many_redirects: "招待URLの転送回数が上限を超えました。",
  redirect_missing: "招待URLの転送先を確認できませんでした。",
  response_too_large: "招待ページのサイズが上限を超えました。",
  unsupported_content: "招待ページの形式を確認できませんでした。",
  meeting_url_not_found: "招待ページから会議URLを確認できませんでした。",
  ambiguous: "招待ページに複数の会議URLがあり、1つに決められませんでした。",
};

export class MeetingUrlResolutionError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.fetch_failed);
    this.name = "MeetingUrlResolutionError";
    this.code = code;
  }
}

function parseSecureUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? "").trim());
  } catch {
    throw new MeetingUrlResolutionError("invalid_url");
  }
  if (parsed.protocol !== "https:") throw new MeetingUrlResolutionError("https_required");
  if (parsed.username || parsed.password) throw new MeetingUrlResolutionError("credentials_rejected");
  return parsed;
}

function isGoogleMeetHost(hostname) {
  return hostname.toLowerCase() === "meet.google.com";
}

function isDirectMeetingHost(hostname) {
  const host = hostname.toLowerCase();
  return isGoogleMeetHost(host)
    || host === "zoom.us"
    || host.endsWith(".zoom.us")
    || host === "teams.microsoft.com"
    || host === "teams.live.com"
    || host === "whereby.com";
}

function normalizeEncodedText(value) {
  let text = String(value ?? "")
    .replace(/&(?:#0*58|#x0*3a|colon);/giu, ":")
    .replace(/&(?:#0*47|#x0*2f|sol);/giu, "/")
    .replace(/&amp;/giu, "&")
    .replace(/\\u0*03a/giu, ":")
    .replace(/\\u0*02f/giu, "/")
    .replace(/\\u0*02e/giu, ".")
    .replace(/\\u0*02d/giu, "-")
    .replace(/\\\//gu, "/")
    .replace(/[／∕⁄]/gu, "/");

  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = text.replace(/%([0-9a-f]{2})/giu, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

function normalizedDirectCandidate(value) {
  const trimmed = String(value ?? "").replace(TRAILING_PUNCTUATION_RE, "");
  try {
    const parsed = parseSecureUrl(trimmed);
    if (!isDirectMeetingHost(parsed.hostname)) return null;
    if (!parsed.pathname || parsed.pathname === "/") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractCandidates(value) {
  const normalized = normalizeEncodedText(value);
  const candidates = new Set();
  MEETING_URL_RE.lastIndex = 0;
  for (const match of normalized.matchAll(MEETING_URL_RE)) {
    const candidate = normalizedDirectCandidate(match[0]);
    if (candidate) candidates.add(candidate);
  }
  return [...candidates];
}

function chooseCandidate(candidates) {
  const unique = [...new Set(candidates)];
  const googleMeet = unique.filter((candidate) => {
    try {
      return isGoogleMeetHost(new URL(candidate).hostname);
    } catch {
      return false;
    }
  });
  if (googleMeet.length === 1) return googleMeet[0];
  if (googleMeet.length > 1) throw new MeetingUrlResolutionError("ambiguous");
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) throw new MeetingUrlResolutionError("ambiguous");
  return null;
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MeetingUrlResolutionError("timeout"));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      Promise.resolve(fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/html, application/json;q=0.9" },
      })),
      timeoutPromise,
    ]);
    return { response, controller };
  } catch (error) {
    if (error instanceof MeetingUrlResolutionError) throw error;
    throw new MeetingUrlResolutionError(error?.name === "AbortError" ? "timeout" : "fetch_failed");
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedBodyUnchecked(response, onReader = () => {}) {
  const declaredLength = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new MeetingUrlResolutionError("response_too_large");
  }
  const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("text/html") && !contentType.startsWith("application/json")) {
    throw new MeetingUrlResolutionError("unsupported_content");
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      throw new MeetingUrlResolutionError("response_too_large");
    }
    return text;
  }

  const reader = response.body.getReader();
  onReader(reader);
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new MeetingUrlResolutionError("response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
}

async function readLimitedBody(response, timeoutMs, controller = null) {
  let timer;
  let activeReader = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      void activeReader?.cancel?.().catch?.(() => {});
      reject(new MeetingUrlResolutionError("timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      readLimitedBodyUnchecked(response, (reader) => { activeReader = reader; }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancelResponseBody(response, controller) {
  controller?.abort();
  try {
    await response.body?.cancel?.();
  } catch {
    // 既に読み取り済み、またはAbort済みなら何もしない。
  }
}

function assertFetchableCalendarUrl(url) {
  if (!CALENDAR_HOSTS.has(url.hostname.toLowerCase())) {
    throw new MeetingUrlResolutionError("host_not_allowed");
  }
}

/**
 * Resolves a direct meeting URL or a Google Calendar invitation URL.
 * Only the two explicitly allowed Calendar hosts are ever fetched.
 */
export async function resolveMeetingUrl(input, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const initial = parseSecureUrl(input);
  if (isDirectMeetingHost(initial.hostname)) {
    if (!initial.pathname || initial.pathname === "/") {
      throw new MeetingUrlResolutionError("meeting_url_not_found");
    }
    return String(input).trim();
  }
  // 任意のHTTPS直リンクは取得せず、そのまま保存する。Jitsiや自前サービスとも
  // 互換性を保ちつつ、外部入力をサーバー側から取得するSSRF経路を作らない。
  if (!CALENDAR_HOSTS.has(initial.hostname.toLowerCase())) {
    return String(input).trim();
  }
  assertFetchableCalendarUrl(initial);
  if (typeof fetchImpl !== "function") throw new MeetingUrlResolutionError("fetch_failed");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new MeetingUrlResolutionError("timeout");
  }

  let current = initial;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertFetchableCalendarUrl(current);
    const { response, controller } = await fetchWithTimeout(fetchImpl, current, timeoutMs);

    if (response.url) {
      const finalUrl = parseSecureUrl(response.url);
      const finalUrlCandidate = normalizedDirectCandidate(finalUrl.toString());
      if (finalUrlCandidate) {
        await cancelResponseBody(response, controller);
        return finalUrlCandidate;
      }
      assertFetchableCalendarUrl(finalUrl);
    }
    const location = response.headers?.get?.("location");

    if (response.status >= 300 && response.status < 400) {
      if (!location) {
        await cancelResponseBody(response, controller);
        throw new MeetingUrlResolutionError("redirect_missing");
      }
      if (redirects === MAX_REDIRECTS) {
        await cancelResponseBody(response, controller);
        throw new MeetingUrlResolutionError("too_many_redirects");
      }
      let next;
      try {
        next = new URL(String(location).trim(), current);
      } catch {
        throw new MeetingUrlResolutionError("invalid_url");
      }
      if (next.protocol !== "https:") throw new MeetingUrlResolutionError("https_required");
      if (next.username || next.password) throw new MeetingUrlResolutionError("credentials_rejected");
      if (isDirectMeetingHost(next.hostname)) {
        const direct = normalizedDirectCandidate(next.toString());
        if (!direct) throw new MeetingUrlResolutionError("meeting_url_not_found");
        await cancelResponseBody(response, controller);
        return direct;
      }
      assertFetchableCalendarUrl(next);
      await cancelResponseBody(response, controller);
      current = next;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      await cancelResponseBody(response, controller);
      throw new MeetingUrlResolutionError("fetch_failed");
    }
    let body;
    try {
      body = await readLimitedBody(response, timeoutMs, controller);
    } catch (error) {
      await cancelResponseBody(response, controller);
      throw error;
    }
    const selected = chooseCandidate(extractCandidates(body));
    if (selected) return selected;
    throw new MeetingUrlResolutionError("meeting_url_not_found");
  }
  throw new MeetingUrlResolutionError("too_many_redirects");
}
