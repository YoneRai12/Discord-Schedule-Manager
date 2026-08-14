import {
  normalizePublicSourceUrl,
  sanitizeVoiceTranscript,
} from "./voice-summary-privacy.mjs";

const DISCORD_CONTENT_LIMIT = 2_000;
const CONTENT_CHUNK_LIMIT = 1_850;
const ALLOWED_MENTIONS_NONE = Object.freeze({ parse: [], users: [], roles: [], repliedUser: false });

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}
function requireSnowflake(value, label) {
  const id = String(value ?? "");
  if (!/^\d{16,20}$/u.test(id)) throw codedError(`${label}が不正です`, "invalid_discord_id");
  return id;
}

function neutralizeMentions(value) {
  return String(value ?? "")
    .replace(/@everyone/giu, "＠everyone")
    .replace(/@here/giu, "＠here")
    .replace(/<@!?\d{16,20}>|<@&\d{16,20}>|<#\d{16,20}>/gu, "[メンション]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ");
}

function formatTimestamp(milliseconds) {
  const totalMilliseconds = Math.max(0, Math.trunc(milliseconds));
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const millis = totalMilliseconds % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function attributedTranscriptBuffer(rawTranscript, sanitizedTranscript) {
  const speakerNames = new Map();
  rawTranscript.segments.forEach((segment, index) => {
    const token = sanitizedTranscript.segments[index].speaker;
    if (!speakerNames.has(token)) {
      const displayName = neutralizeMentions(segment.speakerName || token)
        .replace(/[\r\n]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 100) || token;
      speakerNames.set(token, displayName);
    }
  });
  const lines = [
    "VC文字起こし（発言者別・時刻順）",
    "※AI要約へは話者名・Discord ID・URL等を除いた匿名版だけを送っています。",
    "",
    "話者一覧",
    ...[...speakerNames].map(([token, name]) => `- ${token}: ${name}`),
    "",
    "発言記録",
    ...rawTranscript.segments.map((segment, index) => (
      `[${formatTimestamp(sanitizedTranscript.segments[index].startMs)} - ${formatTimestamp(sanitizedTranscript.segments[index].endMs)}] ${speakerNames.get(sanitizedTranscript.segments[index].speaker)} (${sanitizedTranscript.segments[index].speaker}): ${neutralizeMentions(segment.text)}`
    )),
    "",
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

function listSection(title, values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  return [`### ${title}`, ...values.map((value) => `- ${neutralizeMentions(value)}`), ""];
}

function validatedFactChecks(factChecks) {
  if (!Array.isArray(factChecks)) throw codedError("factChecksが不正です", "invalid_publish_analysis");
  return factChecks.map((check) => {
    if (!check || typeof check !== "object" || !Array.isArray(check.sources)) {
      throw codedError("factCheckが不正です", "invalid_publish_analysis");
    }
    return {
      claim: neutralizeMentions(check.claim).slice(0, 240),
      verdict: ["verified", "contradicted", "inconclusive"].includes(check.verdict)
        ? check.verdict
        : "inconclusive",
      summary: neutralizeMentions(check.summary).slice(0, 800),
      sources: check.sources.slice(0, 5).map((source) => ({
        title: neutralizeMentions(source?.title).replace(/[\r\n]/gu, " ").slice(0, 160),
        url: normalizePublicSourceUrl(source?.url),
      })),
    };
  });
}

function formatSummary(analysis, factChecks) {
  const minutes = analysis?.minutes;
  if (!minutes || typeof minutes !== "object") {
    throw codedError("minutesが不正です", "invalid_publish_analysis");
  }
  const status = analysis.aiUsed === true
    ? "AI要約（文字起こしから生成。重要事項は人が確認してください）"
    : "未確認（AI要約を利用できなかったため、文字起こしを添付しています）";
  const lines = ["## VC議事録", status, ""];
  if (minutes.overview) lines.push("### 概要", neutralizeMentions(minutes.overview), "");
  lines.push(...listSection("トピック", minutes.topics));
  lines.push(...listSection("決定事項", minutes.decisions));
  lines.push(...listSection("アクションアイテム", minutes.actionItems));
  lines.push(...listSection("未解決事項", minutes.openQuestions));

  if (factChecks.length) {
    lines.push("### 公開情報の裏取り");
    for (const check of factChecks) {
      lines.push(`- ${check.claim} — ${check.verdict}`);
      if (check.summary) lines.push(`  ${check.summary}`);
      for (const source of check.sources) {
        // Angle brackets suppress Discord link embeds while preserving a clickable HTTPS URL.
        lines.push(`  - ${source.title}: <${source.url}>`);
      }
    }
    lines.push("");
  } else if (analysis.factCheckUsed === false) {
    lines.push("公開情報の裏取り: 未実施または確認できませんでした。", "");
  }
  return neutralizeMentions(lines.join("\n").trim());
}

function splitContent(content) {
  if (content.length <= CONTENT_CHUNK_LIMIT) return [content];
  const chunks = [];
  let remaining = content;
  while (remaining.length > CONTENT_CHUNK_LIMIT) {
    let cut = remaining.lastIndexOf("\n", CONTENT_CHUNK_LIMIT);
    if (cut < Math.floor(CONTENT_CHUNK_LIMIT / 2)) cut = CONTENT_CHUNK_LIMIT;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  if (chunks.some((chunk) => chunk.length > DISCORD_CONTENT_LIMIT)) {
    throw codedError("議事録の分割に失敗しました", "summary_split_failed");
  }
  return chunks;
}

export class VoiceSummaryPublisher {
  constructor({ client, guildId, outputChannelId } = {}) {
    if (!client?.guilds?.fetch) throw new TypeError("client.guilds.fetch is required");
    this.client = client;
    this.guildId = requireSnowflake(guildId, "guildId");
    this.outputChannelId = requireSnowflake(outputChannelId, "outputChannelId");
  }

  async resolveOutputChannel(session) {
    if (session?.guildId != null && String(session.guildId) !== this.guildId) {
      throw codedError("sessionのguildが設定と一致しません", "voice_summary_guild_mismatch");
    }
    if (session?.outputChannelId != null && String(session.outputChannelId) !== this.outputChannelId) {
      throw codedError("sessionの出力channelが設定と一致しません", "voice_summary_channel_mismatch");
    }
    const guild = await this.client.guilds.fetch(this.guildId);
    if (!guild || String(guild.id) !== this.guildId || !guild.channels?.fetch) {
      throw codedError("guildを再確認できませんでした", "voice_summary_guild_mismatch");
    }
    const channel = await guild.channels.fetch(this.outputChannelId);
    if (
      !channel
      || String(channel.id) !== this.outputChannelId
      || String(channel.guildId ?? channel.guild?.id ?? "") !== this.guildId
      || channel.isTextBased?.() !== true
      || typeof channel.send !== "function"
    ) {
      throw codedError("出力channelを再確認できませんでした", "voice_summary_channel_mismatch");
    }
    return channel;
  }

  async publish({ session = {}, transcript, analysis } = {}) {
    // Always rebuild a UTF-8 text attachment from structured transcript data.
    // Any session audio buffers/paths are deliberately ignored and can never become files.
    const sanitizedTranscript = sanitizeVoiceTranscript(transcript, { knownNames: session.knownNames || [] });
    const factChecks = validatedFactChecks(analysis?.factChecks || []);
    const chunks = splitContent(formatSummary(analysis, factChecks));
    const attachment = attributedTranscriptBuffer(transcript, sanitizedTranscript);
    const channel = await this.resolveOutputChannel(session);
    const messageIds = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const payload = {
        content: chunks[index],
        allowedMentions: { ...ALLOWED_MENTIONS_NONE, parse: [], users: [], roles: [] },
        ...(index === chunks.length - 1 ? {
          files: [{
            attachment,
            name: "voice-transcript.txt",
            description: "発言者名・時刻付きVC文字起こし",
          }],
        } : {}),
      };
      const message = await channel.send(payload);
      if (message?.id) messageIds.push(String(message.id));
    }
    return { channelId: this.outputChannelId, messageIds, partCount: chunks.length };
  }
}
