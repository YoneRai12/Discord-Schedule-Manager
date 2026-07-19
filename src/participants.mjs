const PARTICIPANT_DIRECTIVE_RE = /(?:参加者|対象者|DM送信先|送信先)\s*(?:は|:|：)\s*(.+?)(?=(?:\s+(?:URL|リンク)\s*(?:は|:|：))|(?:\s+(?:を|で|として)\s*(?:テンプレート(?:として)?\s*)?(?:保存|登録)(?:して|する)?(?:ください)?\s*$)|[\r\n。.!！?？]|$)/giu;
const DISCORD_USER_MENTION_RE = /<@!?\d{16,20}>/gu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function normalizeMemberAlias(value) {
  const alias = String(value ?? "").normalize("NFKC").trim();
  const length = [...alias].length;
  if (length < 2 || length > 32) {
    throw new Error("呼び名は2〜32文字で指定してください");
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(alias)) {
    throw new Error("呼び名に使えるのは文字・数字・_・-だけです");
  }
  return {
    alias,
    aliasKey: alias.toLocaleLowerCase("ja-JP"),
  };
}

export function parseMemberAliasList(value) {
  const rawItems = String(value ?? "")
    .replace(DISCORD_USER_MENTION_RE, " ")
    .split(/[、,，\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const aliases = [];
  const keys = new Set();
  for (const item of rawItems) {
    const normalized = normalizeMemberAlias(item);
    if (keys.has(normalized.aliasKey)) continue;
    keys.add(normalized.aliasKey);
    aliases.push(normalized.alias);
  }
  return aliases;
}

export function extractParticipantDirective(rawText) {
  const aliases = [];
  let found = false;
  let disableInvites = false;
  const cleanedText = String(rawText ?? "").replace(PARTICIPANT_DIRECTIVE_RE, (whole, list) => {
    found = true;
    const withoutMentions = String(list).replace(DISCORD_USER_MENTION_RE, " ").trim();
    if (/^(?:なし|不要|誰もなし|DMなし|個別DMなし)$/iu.test(withoutMentions)) {
      disableInvites = true;
    } else {
      aliases.push(...parseMemberAliasList(list));
    }
    return "[MEMBERS_REDACTED]";
  });
  return {
    cleanedText,
    aliases: [...new Set(aliases)],
    found,
    disableInvites,
  };
}

export function redactKnownMemberAliases(rawText, memberAliases) {
  let text = String(rawText ?? "");
  const aliases = [...new Set((memberAliases || []).map((item) => String(item ?? "").trim()).filter(Boolean))]
    .sort((a, b) => [...b].length - [...a].length);
  for (const alias of aliases) {
    text = text.replace(new RegExp(escapeRegExp(alias), "giu"), "[MEMBER_ALIAS]");
  }
  return text;
}
