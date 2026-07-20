import assert from "node:assert/strict";
import test from "node:test";
import {
  MeetingUrlResolutionError,
  resolveMeetingUrl,
} from "../src/meeting-url-resolver.mjs";

function html(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers || {}) },
  });
}

function json(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

test("直接会議URLはfetchせずそのまま返す", async () => {
  let calls = 0;
  const input = "https://meet.google.com/abc-defg-hij?authuser=0";
  const result = await resolveMeetingUrl(input, { fetchImpl: async () => { calls += 1; } });
  assert.equal(result, input);
  assert.equal(calls, 0);

  const zoom = "https://us02web.zoom.us/j/123456789";
  assert.equal(await resolveMeetingUrl(zoom, { fetchImpl: async () => assert.fail("fetch禁止") }), zoom);

  const custom = "https://video.example.org/rooms/team-review";
  assert.equal(await resolveMeetingUrl(custom, { fetchImpl: async () => assert.fail("fetch禁止") }), custom);
});

test("Google Calendar HTMLから通常・entity・escaped・Unicode・percent形式を抽出する", async () => {
  const variants = [
    "https://meet.google.com/aaa-bbbb-ccc",
    "https:&#x2F;&#x2F;meet.google.com&#47;aaa-bbbb-ccc",
    String.raw`https:\/\/meet.google.com\/aaa-bbbb-ccc`,
    "https:／／meet.google.com／aaa-bbbb-ccc",
    "https%253A%252F%252Fmeet.google.com%252Faaa-bbbb-ccc",
  ];
  for (const value of variants) {
    const result = await resolveMeetingUrl("https://calendar.app.google/invite", {
      fetchImpl: async () => html(`<a href="${value}">join</a>`),
    });
    assert.equal(result, "https://meet.google.com/aaa-bbbb-ccc");
  }
});

test("JSON内のescaped URLを抽出する", async () => {
  const body = String.raw`{"conference":"https:\/\/meet.google.com\/json-room"}`;
  const result = await resolveMeetingUrl("https://calendar.google.com/calendar/event", {
    fetchImpl: async () => json(body),
  });
  assert.equal(result, "https://meet.google.com/json-room");
});

test("手動redirectを追跡しLocationの会議URLを返す", async () => {
  const calls = [];
  const result = await resolveMeetingUrl("https://calendar.app.google/start", {
    fetchImpl: async (url, options) => {
      calls.push({ url, redirect: options.redirect });
      if (url.endsWith("/start")) return html("", { status: 302, headers: { location: "https://calendar.google.com/next" } });
      return html("", { status: 302, headers: { location: "https://meet.google.com/redirect-room" } });
    },
  });
  assert.equal(result, "https://meet.google.com/redirect-room");
  assert.deepEqual(calls.map((call) => call.redirect), ["manual", "manual"]);
});

test("Calendar redirectのクエリ内に埋め込まれた会議URLを転送先より先に採用しない", async () => {
  const calls = [];
  const nested = encodeURIComponent("https://meet.google.com/decoy-room");
  const result = await resolveMeetingUrl("https://calendar.app.google/start", {
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return html("", {
          status: 302,
          headers: { location: `https://calendar.google.com/next?continue=${nested}` },
        });
      }
      return html('<a href="https://meet.google.com/actual-room">join</a>');
    },
  });
  assert.equal(result, "https://meet.google.com/actual-room");
  assert.equal(calls.length, 2);
});

test("会議サービスのルートURLは会議として受理しない", async () => {
  await assert.rejects(
    resolveMeetingUrl("https://meet.google.com/"),
    (error) => error.code === "meeting_url_not_found",
  );
  await assert.rejects(
    resolveMeetingUrl("https://zoom.us/"),
    (error) => error.code === "meeting_url_not_found",
  );
});

test("最終response URLがGoogle Meetなら本文取得前に採用する", async () => {
  const response = {
    status: 200,
    url: "https://meet.google.com/final-room",
    headers: new Headers({ "content-type": "text/html" }),
    body: null,
    async text() { assert.fail("本文は不要"); },
  };
  const result = await resolveMeetingUrl("https://calendar.app.google/start", {
    fetchImpl: async () => response,
  });
  assert.equal(result, "https://meet.google.com/final-room");
});

test("複数候補ではGoogle Meetを優先し、Google Meetが複数なら曖昧エラーにする", async () => {
  const preferred = await resolveMeetingUrl("https://calendar.app.google/invite", {
    fetchImpl: async () => html([
      "https://us02web.zoom.us/j/123456",
      "https://meet.google.com/preferred-room",
    ].join(" ")),
  });
  assert.equal(preferred, "https://meet.google.com/preferred-room");

  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", {
      fetchImpl: async () => html("https://meet.google.com/room-one https://meet.google.com/room-two"),
    }),
    (error) => error instanceof MeetingUrlResolutionError && error.code === "ambiguous" && /複数/u.test(error.message),
  );
});

test("任意HTTPS直リンクはfetchせず、Calendarの任意redirectはSSRF対策で拒否する", async () => {
  let calls = 0;
  assert.equal(
    await resolveMeetingUrl("https://127.0.0.1/private", { fetchImpl: async () => { calls += 1; } }),
    "https://127.0.0.1/private",
  );

  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", {
      fetchImpl: async () => ({
        status: 200,
        url: "https://169.254.169.254/latest/meta-data",
        headers: new Headers({ "content-type": "text/html" }),
        body: null,
        async text() { return ""; },
      }),
    }),
    (error) => error.code === "host_not_allowed",
  );
  assert.equal(calls, 0);

  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", {
      fetchImpl: async () => html("", { status: 302, headers: { location: "https://example.invalid/private" } }),
    }),
    (error) => error.code === "host_not_allowed",
  );
});

test("非HTTPS・認証情報・redirect上限超過を安全な日本語エラーで拒否する", async () => {
  await assert.rejects(resolveMeetingUrl("http://calendar.app.google/invite"), /https:\/\//u);
  await assert.rejects(resolveMeetingUrl("https://user:pass@calendar.app.google/invite"), /認証情報/u);

  let calls = 0;
  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/0", {
      fetchImpl: async () => {
        calls += 1;
        return html("", { status: 302, headers: { location: `https://calendar.app.google/${calls}` } });
      },
    }),
    (error) => error.code === "too_many_redirects" && /上限/u.test(error.message),
  );
  assert.equal(calls, 6);
});

test("タイムアウトと1MiBを超える本文を拒否する", async () => {
  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", {
      timeoutMs: 10,
      fetchImpl: async () => new Promise(() => {}),
    }),
    (error) => error.code === "timeout" && /タイムアウト/u.test(error.message),
  );

  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", {
      timeoutMs: 10,
      fetchImpl: async () => ({
        status: 200,
        url: "https://calendar.app.google/invite",
        headers: new Headers({ "content-type": "text/html" }),
        body: null,
        async text() { return new Promise(() => {}); },
      }),
    }),
    (error) => error.code === "timeout",
  );

  let declaredOversizeCancelled = false;
  const declaredOversizeBody = new ReadableStream({
    pull: async () => new Promise(() => {}),
    cancel: () => { declaredOversizeCancelled = true; },
  });
  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", {
      fetchImpl: async () => new Response(declaredOversizeBody, {
        headers: {
          "content-type": "text/html",
          "content-length": String(1024 * 1024 + 1),
        },
      }),
    }),
    (error) => error.code === "response_too_large" && /サイズ/u.test(error.message),
  );
  assert.equal(declaredOversizeCancelled, true);

  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", {
      fetchImpl: async () => html("x".repeat(1024 * 1024 + 1)),
    }),
    (error) => error.code === "response_too_large",
  );

  let cancelled = false;
  const stalledBody = new ReadableStream({
    pull: async () => new Promise(() => {}),
    cancel: () => { cancelled = true; },
  });
  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", {
      timeoutMs: 10,
      fetchImpl: async () => new Response(stalledBody, {
        headers: { "content-type": "text/html" },
      }),
    }),
    (error) => error.code === "timeout",
  );
  assert.equal(cancelled, true);
});

test("未対応content-typeと会議URLなしを安全に拒否する", async () => {
  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", {
      fetchImpl: async () => new Response("binary", { headers: { "content-type": "application/octet-stream" } }),
    }),
    (error) => error.code === "unsupported_content",
  );
  await assert.rejects(
    resolveMeetingUrl("https://calendar.app.google/invite", { fetchImpl: async () => html("予定だけ") }),
    (error) => error.code === "meeting_url_not_found" && /確認できません/u.test(error.message),
  );
});
