import "dotenv/config";
import { loadConfig } from "../src/config.mjs";
import { MeetingInterpreter } from "../src/interpreter.mjs";

const config = loadConfig();
if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY がありません");

const interpreter = new MeetingInterpreter({
  apiKey: config.openaiApiKey,
  model: config.openaiModel,
  reasoningEffort: config.openaiReasoningEffort,
  maxOutputTokens: config.openaiMaxOutputTokens,
  timeZone: config.timeZone,
  defaultDurationMinutes: config.defaultDurationMinutes,
  defaultReminderMinutes: config.defaultReminders,
});

const result = await interpreter.interpret({
  sanitizedText: "2030年1月15日20時から動作確認会議を1時間。[URL_REDACTED] 30分前に通知",
  hasMeetingUrl: true,
});

console.log(JSON.stringify({
  model: config.openaiModel,
  reasoningEffort: config.openaiReasoningEffort,
  action: result.action,
  complete: result.missingFields.length === 0,
  urlReturnedByAi: JSON.stringify(result).includes("https://"),
}));
