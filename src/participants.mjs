const PARTICIPANT_DIRECTIVE_RE = /(?:参加者|対象者|DM送信先|送信先)\s*(?:は|:|：)\s*(.+?)(?=(?:\s+(?:URL|リンク)\s*(?:は|:|：))|(?:\s+(?:を|で|として)\s*(?:テンプレート(?:として)?\s*)?(?:保存|登録)(?:して|する)?(?:ください)?\s*$)|[\r\n。.!！?？]|$)/giu;
const DISABLE_INVITES_RE = /(?:今回(?:は)?\s*)?(?:(?:参加者|対象者|招待者)\s*(?:は|:|：)?\s*(?:なし|不要|誰もなし)|(?:個別\s*)?DM(?:送信)?\s*(?:は|:|：)?\s*(?:なし|不要|送らない|送信しない)|招待\s*(?:は|:|：)?\s*(?:なし|不要|しない))/giu;
const DISCORD_USER_MENTION_RE = /<@!?\d{16,20}>/gu;
const ALIAS_BOUNDARY_RE = /[\s、,，・/／「」『』【】()（）:：]/u;
const LEFT_PARTICLE_RE = /[はにとがをへで]/u;
const MEETING_FIELD_START_RE = /(?:https?:\/\/|www\.|(?:URL|リンク|会議名|タイトル|開始|日時|日程|通知)\s*(?:は|:|：)?|(?:今日|明日|明後日|来週|再来週|今週)|\d{1,2}月\d{1,2}日|\d{1,2}(?:時|[:：]\d{1,2})|(?:全体)?(?:会議|MTG|ミーティング|定例|打ち?合わせ))/iu;

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

function stripAliasDecoration(value) {
  return String(value ?? "")
    .replace(/^(?:と|及び|および)\s*/u, "")
    .replace(/\s*(?:さん|さま|様|ちゃん|くん)$/u, "")
    .replace(/\s*(?:と|及び|および)$/u, "")
    .trim();
}

export function parseMemberAliasList(value, { knownAliases = [] } = {}) {
  const normalizedValue = String(value ?? "").normalize("NFKC");
  const detected = extractKnownMemberAliases(normalizedValue, knownAliases);
  let unknownText = normalizedValue;
  for (const alias of [...detected].sort((a, b) => [...b].length - [...a].length)) {
    unknownText = unknownText.replace(new RegExp(escapeRegExp(alias), "giu"), " ");
  }
  unknownText = unknownText
    .replace(/(?:さん|さま|様|ちゃん|くん)/gu, " ")
    .replace(/(?:^|\s)(?:と|及び|および)(?=\s|$)/gu, " ")
    .replace(/^\s*(?:と|及び|および)\s*/u, "")
    .replace(/\s*(?:と|及び|および)\s*$/u, "");
  const rawItems = unknownText
    .replace(DISCORD_USER_MENTION_RE, " ")
    .split(/[、,，\s]+/u)
    .map(stripAliasDecoration)
    .filter(Boolean);
  const aliases = [...detected];
  const keys = new Set();
  for (const alias of detected) keys.add(normalizeMemberAlias(alias).aliasKey);
  for (const item of rawItems) {
    const normalized = normalizeMemberAlias(item);
    if (keys.has(normalized.aliasKey)) continue;
    keys.add(normalized.aliasKey);
    aliases.push(normalized.alias);
  }
  return aliases;
}

function splitParticipantListText(value) {
  let text = String(value ?? "").replace(DISCORD_USER_MENTION_RE, " ").trim();
  const meetingFieldIndex = text.search(MEETING_FIELD_START_RE);
  const remainderText = meetingFieldIndex >= 0 ? text.slice(meetingFieldIndex).trim() : "";
  if (meetingFieldIndex >= 0) text = text.slice(0, meetingFieldIndex).trim();
  const participantText = text
    .replace(/(?:さん)?(?:です|でお願いします|をお願いします)\s*$/u, "")
    .replace(/(?:と|で|が|は|を|へ|に)\s*$/u, "")
    .trim();
  return { participantText, remainderText };
}

export function extractParticipantDirective(rawText, { knownAliases = [] } = {}) {
  const aliases = [];
  let found = false;
  let disableInvites = false;
  let cleanedText = String(rawText ?? "").replace(DISABLE_INVITES_RE, () => {
    found = true;
    disableInvites = true;
    return "[MEMBERS_REDACTED]";
  });
  cleanedText = cleanedText.replace(PARTICIPANT_DIRECTIVE_RE, (whole, list) => {
    found = true;
    const { participantText, remainderText } = splitParticipantListText(list);
    if (/^(?:なし|不要|誰もなし|DMなし|個別DMなし)$/iu.test(participantText)) {
      disableInvites = true;
    } else if (participantText && !disableInvites) {
      aliases.push(...parseMemberAliasList(participantText, { knownAliases }));
    }
    return `[MEMBERS_REDACTED]${remainderText ? ` ${remainderText}` : ""}`;
  });
  return {
    cleanedText,
    aliases: [...new Set(aliases)],
    found,
    disableInvites,
  };
}

export function redactKnownMemberAliases(rawText, memberAliases) {
  let text = String(rawText ?? "").normalize("NFKC");
  const aliases = [...new Set((memberAliases || [])
    .map((item) => String(item ?? "").normalize("NFKC").trim())
    .filter(Boolean))]
    .sort((a, b) => [...b].length - [...a].length);
  for (const alias of aliases) {
    text = text.replace(new RegExp(escapeRegExp(alias), "giu"), "[MEMBER_ALIAS]");
  }
  return text;
}

/**
 * 登録済みの呼び名が、空白・読点・日本語の助詞で区切られて本文中に現れたものを拾う。
 * AIへ氏名を送る前にローカルで参加者へ解決するための補助で、最終的な送信先は確認画面に表示する。
 */
export function extractKnownMemberAliases(rawText, memberAliases) {
  const text = String(rawText ?? "").normalize("NFKC");
  const foldedText = text.toLocaleLowerCase("ja-JP");
  const aliases = [...new Map((memberAliases || [])
    .map((item) => String(item ?? "").normalize("NFKC").trim())
    .filter(Boolean)
    .map((alias) => [alias.toLocaleLowerCase("ja-JP"), alias])).entries()]
    .map(([aliasKey, alias]) => ({ alias, aliasKey }));

  const startsWithRegisteredAlias = (value) => aliases.some(({ aliasKey }) => value.startsWith(aliasKey));
  const leftBoundaryIsSafe = (index) => {
    if (index === 0) return true;
    const previous = text[index - 1];
    return ALIAS_BOUNDARY_RE.test(previous) || LEFT_PARTICLE_RE.test(previous);
  };
  const rightBoundaryIsSafe = (endIndex) => {
    let rest = foldedText.slice(endIndex);
    if (!rest || ALIAS_BOUNDARY_RE.test(rest[0])) return true;
    if (rest.startsWith("さん")) rest = rest.slice(2);
    if (rest.startsWith("です")) rest = rest.slice(2);
    if (!rest || ALIAS_BOUNDARY_RE.test(rest[0])) return true;
    if (rest.startsWith("と")) {
      const afterParticle = rest.slice(1);
      return !afterParticle || ALIAS_BOUNDARY_RE.test(afterParticle[0]) || startsWithRegisteredAlias(afterParticle);
    }
    return /^(?:は|に|で|が|を|へ)/u.test(rest);
  };

  const candidates = [];
  for (const { alias, aliasKey } of aliases) {
    let searchFrom = 0;
    while (searchFrom < foldedText.length) {
      const index = foldedText.indexOf(aliasKey, searchFrom);
      if (index < 0) break;
      const endIndex = index + aliasKey.length;
      if (leftBoundaryIsSafe(index) && rightBoundaryIsSafe(endIndex)) {
        candidates.push({ alias, aliasKey, index, endIndex });
      }
      searchFrom = index + Math.max(1, aliasKey.length);
    }
  }

  candidates.sort((a, b) => a.index - b.index || (b.endIndex - b.index) - (a.endIndex - a.index));
  const selected = [];
  const selectedKeys = new Set();
  for (const candidate of candidates) {
    if (selectedKeys.has(candidate.aliasKey)) continue;
    if (selected.some((item) => candidate.index < item.endIndex && candidate.endIndex > item.index)) continue;
    selected.push(candidate);
    selectedKeys.add(candidate.aliasKey);
  }
  return selected.sort((a, b) => a.index - b.index).map((item) => item.alias);
}
