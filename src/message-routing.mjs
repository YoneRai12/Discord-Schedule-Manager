/**
 * 通常チャンネルの自然言語入力を、明示的なBotメンションだけに限定する。
 * URLや本文は外部へ送らず、ローカルのDiscord/SQLite情報だけで判定する。
 */
export function meetingMessageText({ message, botUserId, configuredGuildId }) {
  if (!message || message.guildId !== String(configuredGuildId)) return null;
  const botId = String(botUserId ?? "");
  if (!botId) return null;

  if (message.mentions?.has?.(botId, {
    ignoreEveryone: true,
    ignoreRoles: true,
    ignoreRepliedUser: true,
  })) {
    const mentionPattern = new RegExp(`<@!?${botId}>`, "gu");
    return String(message.content ?? "").replace(mentionPattern, " ").trim();
  }
  return null;
}
