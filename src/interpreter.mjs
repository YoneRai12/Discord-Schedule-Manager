import OpenAI from "openai";
import { assertSafeForAi, containsUrlLike, safeDisplayText } from "./privacy.mjs";
import { normalizeReminderMinutes, parseJstDateTime } from "./time.mjs";

export const MEETING_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["create", "update", "unknown"] },
    meetingId: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    startsAt: { type: ["string", "null"] },
    durationMinutes: { type: ["integer", "null"], minimum: 5, maximum: 1440 },
    reminderMinutes: {
      type: "array",
      maxItems: 12,
      items: { type: "integer", minimum: 0, maximum: 10080 },
    },
    providedFields: {
      type: "array",
      items: {
        type: "string",
        enum: ["title", "startsAt", "durationMinutes", "reminderMinutes", "meetingUrl"],
      },
    },
    missingFields: {
      type: "array",
      items: {
        type: "string",
        enum: ["title", "startsAt", "meetingUrl", "meetingId", "requestedChanges"],
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    clarification: { type: ["string", "null"] },
  },
  required: [
    "action",
    "meetingId",
    "title",
    "startsAt",
    "durationMinutes",
    "reminderMinutes",
    "providedFields",
    "missingFields",
    "confidence",
    "clarification",
  ],
};

const SYSTEM_PROMPT = `
あなたはDiscord会議管理Botの入力整形器です。ユーザーの日本語を会議作成または更新の構造化データへ変換します。

安全上の絶対条件:
- URLそのものは入力されません。[URL_REDACTED] と hasMeetingUrl だけを参照してください。
- URLを生成、推測、復元、出力しないでください。
- DiscordのユーザーID、サーバーID、チャンネルIDを要求・生成しないでください。

日時規則:
- 基準日時とタイムゾーンは入力JSONにあります。
- startsAt は必ず UTCオフセット付きISO 8601（例: 2026-07-20T20:30:00+09:00）または null。
- 「来週月曜」「明日」なども基準日時から解決します。曜日と日付が矛盾する場合は startsAt=null にします。
- durationMinutes は明記されなければ null。
- reminderMinutes は明記されなければ入力JSONの defaultReminderMinutes をそのまま使います。

action規則:
- 新しい会議を登録する依頼は create。
- 表示された8文字の会議IDを指定して内容やURLを変える依頼は update。
- 会議操作でない、意図が曖昧、または作成か更新か判別できない場合は unknown。
- providedFields はユーザーが明示的に指定・変更した項目だけ。URLがある場合は meetingUrl を含めます。
- create の不足候補は title, startsAt, meetingUrl。
- update の不足候補は meetingId, requestedChanges。
- clarification は不足や矛盾を一文で尋ねる場合だけ設定します。
`.trim();

function parseResponseText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  return "";
}

function normalizeMeetingId(value) {
  const id = String(value ?? "").trim().toUpperCase().replace(/^#/, "");
  return /^[A-Z0-9]{8}$/u.test(id) ? id : null;
}

export function validateInterpretation(
  raw,
  {
    hasMeetingUrl,
    defaultDurationMinutes = 60,
    defaultReminderMinutes = [30, 0],
    nowMs = Date.now(),
  },
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("AIの構造化出力がオブジェクトではありません");
  }
  if (containsUrlLike(JSON.stringify(raw))) {
    throw new Error("AI出力にURLが含まれたため破棄しました");
  }

  const action = ["create", "update", "unknown"].includes(raw.action) ? raw.action : "unknown";
  const providedFields = new Set(Array.isArray(raw.providedFields) ? raw.providedFields : []);
  if (hasMeetingUrl) providedFields.add("meetingUrl");
  const title = safeDisplayText(raw.title, 100) || null;
  let startsAtMs = null;
  if (raw.startsAt) {
    try {
      startsAtMs = parseJstDateTime(raw.startsAt);
    } catch {
      startsAtMs = null;
    }
  }
  if (startsAtMs != null && startsAtMs < nowMs - 5 * 60_000) startsAtMs = null;
  const durationMinutes = Number.isSafeInteger(raw.durationMinutes)
    && raw.durationMinutes >= 5
    && raw.durationMinutes <= 1_440
    ? raw.durationMinutes
    : defaultDurationMinutes;
  const reminderMinutes = normalizeReminderMinutes(raw.reminderMinutes, defaultReminderMinutes);
  const meetingId = normalizeMeetingId(raw.meetingId);
  const missingFields = [];

  if (action === "create") {
    if (!title) missingFields.push("title");
    if (startsAtMs == null) missingFields.push("startsAt");
    if (!hasMeetingUrl) missingFields.push("meetingUrl");
  } else if (action === "update") {
    if (!meetingId) missingFields.push("meetingId");
    const updateFields = [...providedFields].filter((field) => (
      field === "meetingUrl"
      || (field === "title" && title)
      || (field === "startsAt" && startsAtMs != null)
      || field === "durationMinutes"
      || field === "reminderMinutes"
    ));
    if (updateFields.length === 0) missingFields.push("requestedChanges");
  }

  return {
    action,
    meetingId,
    title,
    startsAtMs,
    durationMinutes,
    reminderMinutes,
    providedFields: [...providedFields],
    missingFields,
    confidence: Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0,
    clarification: safeDisplayText(raw.clarification, 300) || null,
  };
}

export class MeetingInterpreter {
  constructor({
    apiKey,
    model = "gpt-5.4-nano",
    maxOutputTokens = 1_200,
    timeZone = "Asia/Tokyo",
    defaultDurationMinutes = 60,
    defaultReminderMinutes = [30, 0],
    client = null,
  }) {
    this.client = client || (apiKey ? new OpenAI({ apiKey }) : null);
    this.model = model;
    this.maxOutputTokens = maxOutputTokens;
    this.timeZone = timeZone;
    this.defaultDurationMinutes = defaultDurationMinutes;
    this.defaultReminderMinutes = defaultReminderMinutes;
  }

  get configured() {
    return Boolean(this.client);
  }

  async interpret({ sanitizedText, hasMeetingUrl, nowMs = Date.now() }) {
    if (!this.client) throw new Error("OPENAI_API_KEY が設定されていません");
    assertSafeForAi(sanitizedText);
    const userPayload = {
      messageText: sanitizedText,
      hasMeetingUrl: Boolean(hasMeetingUrl),
      currentDateTime: new Date(nowMs).toISOString(),
      timeZone: this.timeZone,
      defaultReminderMinutes: this.defaultReminderMinutes,
    };
    const response = await this.client.responses.create({
      model: this.model,
      store: false,
      max_output_tokens: this.maxOutputTokens,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "meeting_extraction",
          strict: true,
          schema: MEETING_EXTRACTION_SCHEMA,
        },
      },
    });
    const outputText = parseResponseText(response).trim();
    if (!outputText) throw new Error("AIから構造化結果が返りませんでした");
    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      throw new Error("AIの構造化結果をJSONとして解釈できませんでした");
    }
    return validateInterpretation(parsed, {
      hasMeetingUrl,
      defaultDurationMinutes: this.defaultDurationMinutes,
      defaultReminderMinutes: this.defaultReminderMinutes,
      nowMs,
    });
  }
}
