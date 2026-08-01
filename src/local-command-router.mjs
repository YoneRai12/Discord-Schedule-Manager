import { extractMeetingId } from "./meeting-id.mjs";

function hasUrlLike(text) {
  return /(?:https?:\/\/|www\.)\S+/iu.test(text);
}

function looksLikeMeetingComposition(text) {
  const hasSchedule = /(?:今日|明日|明後日|今週|来週|再来週|\d{1,2}月\d{1,2}日|\d{1,2}(?:時|[:：]\d{1,2}))/u.test(text);
  const hasMeetingWords = /(?:会議|予定|MTG|ミーティング|定例|打ち?合わせ|登録|作成)/iu.test(text);
  return hasMeetingWords && (hasSchedule || hasUrlLike(text));
}

function isBareUrl(text) {
  const urls = String(text).match(/(?:https?:\/\/|www\.)\S+/giu) || [];
  if (urls.length !== 1) return false;
  const remainder = String(text)
    .replace(urls[0], "")
    .replace(/[\s「」『』【】()（）,，、。!！?？~〜]+/gu, "")
    .trim();
  return !remainder || /^(?:これ|こちら|こっち)(?:です|ね)?$/u.test(remainder);
}

function isMeetingUrlUpdate(text) {
  if (/(?:新しい|新規|新しく).*(?:会議|予定|作成|登録|追加)|(?:会議|予定).*(?:作成|登録|追加|作って)/u.test(text)) return false;
  return /\bmeeting\s+url\b/iu.test(text)
    || /(?:会議)?(?:URL|リンク).*(?:変更|更新|差し替え|差し換え|変えて|直して)/iu.test(text)
    || /(?:変更|更新|差し替え|差し換え|変えて|直して).*(?:会議)?(?:URL|リンク)/iu.test(text)
    || /この\s*(?:URL|リンク)\s*(?:に|へ)?\s*(?:して|変更|差し替え|差し換え)/iu.test(text);
}

function capturedAlias(text, patterns) {
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1];
    if (value) return value.normalize("NFKC").trim();
  }
  return null;
}

const HELP_PATTERNS = Object.freeze([
  /^(?:ヘルプ|help)(?:を)?(?:見せて|表示して|お願い)?$/iu,
  /(?:使い方|使いかた)(?:を)?(?:教えて|知りたい|見せて|説明して)?/u,
  /(?:どう|どー)(?:やって)?(?:使う|つかう|使えば|つかえば|使ったら|つかったら)(?:の|いい|いいの|いいですか)?/u,
  /(?:何|なに)(?:が)?(?:できる|出来る)(?:の|のか|こと)?/u,
  /(?:できること|出来ること|機能)(?:を)?(?:教えて|見せて|説明して|知りたい)/u,
]);

const TEMPLATE_HELP_PATTERNS = Object.freeze([
  /(?:参加者|出席者)?テンプレ(?:ート)?(?:って|は|を)?\s*(?:どう|どー)(?:やって)?(?:作る|つくる|作れば|つくれば|登録する|保存する)(?:の|には|といい|のがいい|んですか|のですか|いいですか)?/u,
  /(?:参加者|出席者)?テンプレ(?:ート)?(?:の|を)?\s*(?:作り方|つくり方|作る方法|つくる方法|登録(?:する)?方法|保存(?:する)?方法)(?:を|が)?(?:教えて|知りたい|見せて|説明して)?/u,
]);

export function isHelpIntent(text) {
  const normalized = String(text ?? "").normalize("NFKC").trim();
  return HELP_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isTemplateHelpIntent(text) {
  const normalized = String(text ?? "").normalize("NFKC").trim();
  return TEMPLATE_HELP_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function parseGuildNaturalCommand(rawText, { knownMeetingIds = [] } = {}) {
  const text = String(rawText ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return { action: "help" };
  const meetingId = extractMeetingId(text, { knownIds: knownMeetingIds });

  const voiceSessionId = text.match(/(?:^|\s)([A-F0-9]{10})(?=\s|$)/iu)?.[1]?.toUpperCase() || null;
  if (/(?:VC|ボイス|音声).*(?:プライバシー|保存期間|データの扱い)|(?:プライバシー|保存期間).*(?:VC|ボイス|音声)/iu.test(text)) {
    return { action: "voice_privacy" };
  }
  if (/(?:VC|ボイス|音声|文字起こし).*(?:状態|状況|同意.*確認)|(?:状態|状況).*(?:VC|ボイス|文字起こし)/iu.test(text)) {
    return { action: "voice_status" };
  }
  if (voiceSessionId && /(?:再処理|再作成|やり直)/u.test(text)) {
    return { action: "voice_reprocess", sessionId: voiceSessionId };
  }
  if (voiceSessionId && /(?:削除|消去|消して)/u.test(text)) {
    return { action: "voice_delete", sessionId: voiceSessionId };
  }
  if (/(?:VC|ボイス|音声|文字起こし|録音).*(?:停止|終了|止め)|(?:停止|終了|止め).*(?:VC|ボイス|音声|文字起こし|録音)/iu.test(text)) {
    return { action: "voice_stop" };
  }
  if (/(?:VC|ボイス|音声).*(?:文字起こし|議事録|録音).*(?:開始|始め|作って)|(?:文字起こし|議事録|録音).*(?:開始|始め).*(?:VC|ボイス|音声)?/iu.test(text)) {
    const title = text
      .replace(/(?:VC|ボイス(?:チャンネル)?|音声|文字起こし|議事録|録音|を|の|開始|始めて?|作って|して|ください|お願い)/giu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return { action: "voice_start", title: title || null };
  }

  const meetingComposition = looksLikeMeetingComposition(text);
  if (!meetingComposition && isTemplateHelpIntent(text)) return { action: "template_help" };
  if (!meetingComposition && isHelpIntent(text)) return { action: "help" };
  if (isBareUrl(text) || isMeetingUrlUpdate(text)) {
    return { action: "meeting_url_update", meetingId, hasMeetingUrl: hasUrlLike(text) };
  }
  if (/自分の(?:個別)?通知設定|個人通知設定|マイ通知/u.test(text) && /(?:見せて|確認|表示|どうなって)/u.test(text)) {
    return { action: "my_reminders_show" };
  }
  if (!meetingComposition && /(?:会議|予定)(?:の)?一覧|今後の(?:会議|予定)|次の会議/u.test(text)) return { action: "meeting_list" };
  if (meetingId && /(?:出欠|参加状況|回答状況|状況を見|誰が(?:来る|参加))/u.test(text)) {
    return { action: "meeting_status", meetingId };
  }
  if (meetingId && /(?:中止|キャンセル|取り消)/u.test(text)) {
    return { action: "meeting_cancel", meetingId };
  }
  if (/(?:呼び名|メンバー)(?:の)?一覧|登録メンバー(?:を)?見/u.test(text)) {
    return { action: "member_list" };
  }

  const removeAlias = capturedAlias(text, [
    /呼び名\s*[「『"]?([\p{L}\p{N}_-]{2,32})[」』"]?\s*を\s*(?:削除|消して|解除)/u,
    /メンバー(?:登録)?\s*[「『"]?([\p{L}\p{N}_-]{2,32})[」』"]?\s*を\s*(?:削除|解除)/u,
  ]);
  if (removeAlias) return { action: "member_remove", alias: removeAlias };

  const addAlias = capturedAlias(text, [
    /<@!?\d{16,20}>\s*を\s*[「『"]?([\p{L}\p{N}_-]{2,32})[」』"]?\s*(?:として|で)\s*(?:登録|覚えて)/u,
    /[「『"]([\p{L}\p{N}_-]{2,32})[」』"]\s*(?:という)?(?:呼び名|名前)?(?:として|で)?\s*(?:登録|覚えて)/u,
    /呼び名(?:登録)?\s*(?:は|:|：)\s*([\p{L}\p{N}_-]{2,32})/u,
    /(?:この人|このメンバー)\s*を\s*([\p{L}\p{N}_-]{2,32})\s*(?:として|で)\s*(?:登録|覚えて)/u,
  ]);
  if (addAlias && /(?:登録|覚えて)/u.test(text)) return { action: "member_add", alias: addAlias };

  if (meetingId && /(?:個別DM|DM|招待).*(?:送って|送信|追加)|(?:送って|送信).*(?:個別DM|DM|招待)/u.test(text)) {
    return { action: "meeting_invite", meetingId };
  }
  return null;
}
