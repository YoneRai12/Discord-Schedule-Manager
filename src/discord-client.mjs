import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

// VCチャットの原文を読み上げBotの音声から再文字起こしせず、
// 発言者付き議事録に直接収録するためMessageContent intentを使用する。
export const MEETING_GATEWAY_INTENTS = Object.freeze([
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.MessageContent,
]);

export const MEETING_PARTIALS = Object.freeze([Partials.Channel]);

export function createDiscordClient() {
  return new Client({ intents: MEETING_GATEWAY_INTENTS, partials: MEETING_PARTIALS });
}
