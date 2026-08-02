import OpenAI from "openai";
import { normalizeMeetingId } from "./meeting-id.mjs";
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
      type: ["array", "null"],
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
        enum: ["title", "startsAt", "durationMinutes", "reminderMinutes", "meetingUrl", "meetingId", "requestedChanges"],
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

入力規則:
- 会議名、日時、通知、操作語は順不同で、句読点なし・単語の羅列・くだけた日本語でも意味から整理してください。
- 参加者名、Discordメンション、会議ID、URLはBotが先にローカル分離し、プレースホルダーへ置換する場合があります。
- 明確な会議名がないとき、参加者名や日時を会議名として捏造せず title=null にしてください。Botが確認可能な仮名を付けます。

安全上の絶対条件:
- URLそのものは入力されません。[URL_REDACTED] と hasMeetingUrl だけを参照してください。
- URLを生成、推測、復元、出力しないでください。
- DiscordのユーザーID、サーバーID、チャンネルIDを要求・生成しないでください。
- [MEMBER_ALIAS]、[MEMBERS_REDACTED]、[MEETING_ID] の実値を推測・復元しないでください。

日時規則:
- 基準日時とタイムゾーンは入力JSONにあります。
- startsAt は必ず UTCオフセット付きISO 8601（例: 2026-07-20T20:30:00+09:00）または null。
- 「来週月曜」「明日」なども基準日時から解決します。曜日と日付が矛盾する場合は startsAt=null にします。
- durationMinutes は明記されなければ null。
- reminderMinutes は明記されなければ null、明示的な「通知なし」は空配列 []、時刻指定があれば分単位の配列にします。

action規則:
- 新しい会議を登録する依頼は create。
- 既存の会議について、内容やURLを変える依頼は update。会議IDがなくても「さっきの会議」「全体MTGはこっち」のような表現から更新意図を判定します。
- 会議IDが入力にない場合は推測せず meetingId=null にしてください。対象会議はBotが返信先・会議名・ローカル保存情報から安全に決めます。
- 会議操作でない、意図が曖昧、または作成か更新か判別できない場合は unknown。
- providedFields はユーザーが明示的に指定・変更した項目だけ。URLがある場合は meetingUrl を含めます。
- create の不足候補は title, startsAt。会議URLは未定のまま作成でき、後から追加できます。
- update の不足候補は requestedChanges。meetingIdの不足はBotがローカルで解決するため、不足項目にしません。
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
  const requestedFields = new Set(Array.isArray(raw.providedFields) ? raw.providedFields : []);
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
  const hasDuration = Number.isSafeInteger(raw.durationMinutes)
    && raw.durationMinutes >= 5
    && raw.durationMinutes <= 1_440;
  const durationMinutes = hasDuration ? raw.durationMinutes : defaultDurationMinutes;
  const hasReminderMinutes = Array.isArray(raw.reminderMinutes)
    && raw.reminderMinutes.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_080);
  const reminderMinutes = hasReminderMinutes
    ? [...new Set(raw.reminderMinutes)].slice(0, 12).sort((a, b) => b - a)
    : normalizeReminderMinutes(null, defaultReminderMinutes);
  const meetingId = normalizeMeetingId(raw.meetingId, { required: false });
  const missingFields = [];
  const providedFields = new Set();
  if (requestedFields.has("title") && title) providedFields.add("title");
  if (requestedFields.has("startsAt") && startsAtMs != null) providedFields.add("startsAt");
  if (requestedFields.has("durationMinutes") && hasDuration) providedFields.add("durationMinutes");
  if (requestedFields.has("reminderMinutes") && hasReminderMinutes) providedFields.add("reminderMinutes");
  if (hasMeetingUrl) providedFields.add("meetingUrl");

  if (action === "create") {
    if (!title) missingFields.push("title");
    if (startsAtMs == null) missingFields.push("startsAt");
  } else if (action === "update") {
    if (requestedFields.has("title") && !title) missingFields.push("title");
    if (requestedFields.has("startsAt") && startsAtMs == null) missingFields.push("startsAt");
    if (requestedFields.has("durationMinutes") && !hasDuration) missingFields.push("durationMinutes");
    if (requestedFields.has("reminderMinutes") && !hasReminderMinutes) missingFields.push("reminderMinutes");
    if (requestedFields.has("meetingUrl") && !hasMeetingUrl) missingFields.push("meetingUrl");
    if (providedFields.size === 0 && missingFields.length === 0) missingFields.push("requestedChanges");
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
    model = "gpt-5.6-terra",
    reasoningEffort = "medium",
    maxOutputTokens = 1_200,
    timeZone = "Asia/Tokyo",
    defaultDurationMinutes = 60,
    defaultReminderMinutes = [30, 0],
    client = null,
    provider = null,
  }) {
    this.client = client || (apiKey ? new OpenAI({ apiKey }) : null);
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.maxOutputTokens = maxOutputTokens;
    this.timeZone = timeZone;
    this.defaultDurationMinutes = defaultDurationMinutes;
    this.defaultReminderMinutes = defaultReminderMinutes;
  }

  get configured() {
    return Boolean(this.provider?.configured || this.client);
  }

  async initialize() {
    await this.provider?.initialize?.();
  }

  close() {
    this.provider?.close?.();
  }

  async interpret({ sanitizedText, hasMeetingUrl, nowMs = Date.now() }) {
    if (!this.configured) throw new Error("会議AIプロバイダーが設定されていません");
    assertSafeForAi(sanitizedText);
    const userPayload = {
      messageText: sanitizedText,
      hasMeetingUrl: Boolean(hasMeetingUrl),
      currentDateTime: new Date(nowMs).toISOString(),
      timeZone: this.timeZone,
      defaultReminderMinutes: this.defaultReminderMinutes,
    };
    let outputText;
    if (this.provider) {
      outputText = String(await this.provider.generateStructured({
        systemPrompt: SYSTEM_PROMPT,
        userPayload,
        outputSchema: MEETING_EXTRACTION_SCHEMA,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        maxOutputTokens: this.maxOutputTokens,
      })).trim();
    } else {
      const response = await this.client.responses.create({
        model: this.model,
        reasoning: { effort: this.reasoningEffort },
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
      outputText = parseResponseText(response).trim();
    }
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
