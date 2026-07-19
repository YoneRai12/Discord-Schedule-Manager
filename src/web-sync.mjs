import crypto from "node:crypto";
import { buildWebProjection } from "./web-projection.mjs";

function compactCode(error) {
  return String(error?.code ?? error?.status ?? error?.name ?? "sync_failed")
    .replace(/[^a-zA-Z0-9_.-]/gu, "_")
    .slice(0, 64) || "sync_failed";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertEndpoint(value) {
  const endpoint = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:")) {
    throw new Error("MEETING_WEB_SYNC_URL must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("MEETING_WEB_SYNC_URL must not contain credentials");
  }
  return endpoint.toString();
}

export function signWebSyncRequest({ secret, pathname, timestampMs, nonce, body }) {
  if (!secret) throw new TypeError("secret is required");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const signedValue = ["POST", pathname, String(timestampMs), nonce, bodyHash].join("\n");
  const signature = crypto.createHmac("sha256", secret).update(signedValue).digest("hex");
  return { bodyHash, signature };
}

export class MeetingWebSync {
  constructor({
    url = "",
    secret = "",
    authToken = "",
    store,
    intervalSeconds = 60,
    timeoutMs = 8_000,
    maxRetries = 2,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    nonce = () => crypto.randomBytes(16).toString("hex"),
    sleep = delay,
    logger = console,
  }) {
    const secretValue = String(secret).trim();
    this.configured = Boolean(String(url).trim() && secretValue);
    this.url = this.configured ? assertEndpoint(String(url).trim()) : "";
    this.pathname = this.configured ? new URL(this.url).pathname : "";
    this.secret = this.configured ? secretValue : "";
    this.authToken = String(authToken).trim();
    this.store = store;
    this.intervalMs = Math.max(15, Number(intervalSeconds)) * 1_000;
    this.timeoutMs = Math.max(250, Number(timeoutMs));
    this.maxRetries = Math.max(0, Math.min(5, Number(maxRetries)));
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.nonce = nonce;
    this.sleep = sleep;
    this.logger = logger;
    this.timer = null;
    this.syncPromise = null;
    if (secretValue && secretValue.length < 32) {
      throw new TypeError("MEETING_WEB_SYNC_SECRET must contain at least 32 characters");
    }
    if (this.configured && typeof store?.getSnapshot !== "function") {
      throw new TypeError("store.getSnapshot is required when web sync is configured");
    }
    if (this.configured && typeof fetchImpl !== "function") {
      throw new TypeError("fetch is required when web sync is configured");
    }
  }

  start() {
    if (!this.configured || this.timer) return false;
    void this.sync().catch(() => {});
    this.timer = setInterval(() => void this.sync().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
    return true;
  }

  stop() {
    if (!this.timer) return false;
    clearInterval(this.timer);
    this.timer = null;
    return true;
  }

  close() {
    this.stop();
  }

  requestSync() {
    if (!this.configured) return false;
    void this.sync().catch(() => {});
    return true;
  }

  async sync() {
    if (!this.configured) return { configured: false, sent: false };
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async performSync() {
    const generatedAtMs = Number(this.now());
    const projection = buildWebProjection(this.store.getSnapshot(), {
      publicIdSecret: this.secret,
      generatedAtMs,
    });
    const body = JSON.stringify(projection);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const timestamp = String(generatedAtMs);
      const nonce = String(this.nonce());
      if (!/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
        throw Object.assign(new Error("invalid sync nonce"), { code: "invalid_nonce", retryable: false });
      }
      const { bodyHash, signature } = signWebSyncRequest({
        secret: this.secret,
        pathname: this.pathname,
        timestampMs: timestamp,
        nonce,
        body,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = {
          "content-type": "application/json",
          "x-meeting-sync-timestamp": timestamp,
          "x-meeting-sync-nonce": nonce,
          "x-meeting-sync-body-sha256": bodyHash,
          "x-meeting-sync-signature": signature,
        };
        if (this.authToken) {
          headers["oai-sites-authorization"] = `Bearer ${this.authToken}`;
        }
        const response = await this.fetchImpl(this.url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
          redirect: "error",
        });
        if (response.ok) return { configured: true, sent: true, status: response.status };
        const error = Object.assign(new Error("web sync HTTP error"), {
          code: `http_${response.status}`,
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
        throw error;
      } catch (error) {
        const retryable = error?.retryable !== false;
        const finalAttempt = attempt >= this.maxRetries || !retryable;
        const code = compactCode(error?.name === "AbortError"
          ? Object.assign(new Error("timeout"), { code: "timeout" })
          : error);
        if (finalAttempt) {
          this.logger.error?.(`[web-sync] failed code=${code}`);
          throw Object.assign(new Error("WEB同期に失敗しました"), { code });
        }
        this.logger.warn?.(`[web-sync] retry attempt=${attempt + 1} code=${code}`);
        await this.sleep(Math.min(5_000, 250 * (2 ** attempt)));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("unreachable");
  }
}
