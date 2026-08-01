import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

// DiscordはBot自身が直接メンションされたメッセージについては、
// privilegedなMessageContent intentなしでもcontentを提供する。
// 読み取り範囲を広げないため、このBotは必要最小限のintentだけを要求する。
export const MEETING_GATEWAY_INTENTS = Object.freeze([
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildVoiceStates,
]);

export const MEETING_PARTIALS = Object.freeze([Partials.Channel]);

export function createDiscordClient() {
  return new Client({ intents: MEETING_GATEWAY_INTENTS, partials: MEETING_PARTIALS });
}
