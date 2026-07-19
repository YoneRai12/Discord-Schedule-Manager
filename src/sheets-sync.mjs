const SHEET_TITLES = ["会議一覧", "出欠", "通知ログ"];
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function statusJa(value) {
  return ({
    active: "開催予定",
    cancelled: "中止",
    completed: "終了",
    attending: "参加",
    maybe: "未定",
    declined: "欠席",
    pending: "待機",
    sending: "送信中",
    sent: "送信済み",
    skipped: "スキップ",
  })[value] || value;
}
function iso(value) {
  return value == null ? "" : new Date(Number(value)).toISOString();
}

export function buildSheetTables(snapshot, { syncUrls = false } = {}) {
  const meetingById = new Map(snapshot.meetings.map((meeting) => [meeting.id, meeting]));
  const meetings = [[
    "会議ID",
    "タイトル",
    "開始日時(UTC)",
    "終了日時(UTC)",
    "状態",
    "作成者",
    "通知",
    "会議URL",
  ]];
  for (const meeting of snapshot.meetings) {
    meetings.push([
      meeting.id,
      meeting.title,
      iso(meeting.startsAtMs),
      iso(meeting.endsAtMs),
      statusJa(meeting.status),
      meeting.createdByName,
      meeting.reminderMinutes.join(","),
      syncUrls ? meeting.meetingUrl : (meeting.meetingUrl ? "登録済み（Discordで確認）" : "未登録"),
    ]);
  }

  const rsvps = [["会議ID", "タイトル", "表示名", "回答", "更新日時(UTC)"]];
  for (const rsvp of snapshot.rsvps) {
    rsvps.push([
      rsvp.meetingId,
      meetingById.get(rsvp.meetingId)?.title || "",
      rsvp.displayName,
      statusJa(rsvp.status),
      iso(rsvp.updatedAtMs),
    ]);
  }

  const deliveries = [["会議ID", "通知タイミング(分前)", "状態", "送信日時(UTC)"]];
  for (const delivery of snapshot.deliveries) {
    deliveries.push([
      delivery.meetingId,
      delivery.offsetMinutes,
      statusJa(delivery.status),
      iso(delivery.sentAtMs),
    ]);
  }
  return { "会議一覧": meetings, "出欠": rsvps, "通知ログ": deliveries };
}

function retryableStatus(error) {
  const status = Number(error?.code || error?.response?.status || 0);
  return status === 429 || status === 500 || status === 503;
}

export class GoogleSheetsSync {
  constructor({ spreadsheetId, keyFile, syncUrls, store, logger = console }) {
    this.spreadsheetId = spreadsheetId;
    this.keyFile = keyFile;
    this.syncUrls = syncUrls;
    this.store = store;
    this.logger = logger;
    this.api = null;
    this.syncPromise = null;
    this.debounceTimer = null;
  }

  get configured() {
    return Boolean(this.spreadsheetId && this.keyFile);
  }

  async initialize() {
    if (!this.configured) return false;
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({ keyFile: this.keyFile, scopes: [SHEETS_SCOPE] });
    this.api = google.sheets({ version: "v4", auth });
    await this.ensureSheets();
    return true;
  }

  async withRetry(operation) {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!retryableStatus(error) || attempt === 4) throw error;
        const delay = Math.min(8_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  async ensureSheets() {
    const response = await this.withRetry(() => this.api.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: "sheets.properties.title",
    }));
    const existing = new Set((response.data.sheets || []).map((sheet) => sheet.properties?.title));
    const missing = SHEET_TITLES.filter((title) => !existing.has(title));
    if (!missing.length) return;
    await this.withRetry(() => this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      },
    }));
  }

  requestSync() {
    if (!this.api || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.sync().catch((error) => {
        const status = Number(error?.code || error?.response?.status || 0) || "unknown";
        this.logger.error(`[sheets] 同期に失敗しました status=${status}`);
      });
    }, 1_000);
    this.debounceTimer.unref?.();
  }

  async sync() {
    if (!this.api) return false;
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async performSync() {
    const tables = buildSheetTables(this.store.getSnapshot(), { syncUrls: this.syncUrls });
    const data = Object.entries(tables).map(([title, values]) => ({
      range: `'${title}'!A1`,
      majorDimension: "ROWS",
      values,
    }));
    await this.withRetry(() => this.api.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: "RAW", data },
    }));

    const ranges = Object.entries(tables).map(([title, values]) => `'${title}'!A${values.length + 1}:Z`);
    await this.withRetry(() => this.api.spreadsheets.values.batchClear({
      spreadsheetId: this.spreadsheetId,
      requestBody: { ranges },
    }));
    return true;
  }

  close() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }
}
