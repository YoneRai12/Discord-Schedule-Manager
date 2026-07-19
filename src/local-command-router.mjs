function meetingIdFrom(text) {
  return text.match(/(?:^|[\s#])([A-Z0-9]{8})(?=$|[\s、。.!！?？:：のをへで])/iu)?.[1]?.toUpperCase() || null;
}

function capturedAlias(text, patterns) {
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1];
    if (value) return value.normalize("NFKC").trim();
  }
  return null;
}

export function parseGuildNaturalCommand(rawText) {
  const text = String(rawText ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return { action: "help" };
  const meetingId = meetingIdFrom(text);

  if (/^(?:ヘルプ|help|使い方|何ができる)/iu.test(text)) return { action: "help" };
  if (/自分の(?:個別)?通知設定|個人通知設定|マイ通知/u.test(text) && /(?:見せて|確認|表示|どうなって)/u.test(text)) {
    return { action: "my_reminders_show" };
  }
  if (/(?:会議|予定)(?:の)?一覧|今後の(?:会議|予定)|次の会議/u.test(text)) return { action: "meeting_list" };
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
