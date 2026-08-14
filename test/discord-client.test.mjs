import test from "node:test";
import assert from "node:assert/strict";
import { GatewayIntentBits, Partials } from "discord.js";
import { MEETING_GATEWAY_INTENTS, MEETING_PARTIALS } from "../src/discord-client.mjs";

test("VCチャット原文を収録するためMessageContent intentを要求する", () => {
  assert.deepEqual(MEETING_GATEWAY_INTENTS, [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ]);
  assert.deepEqual(MEETING_PARTIALS, [Partials.Channel]);
  assert.equal(MEETING_GATEWAY_INTENTS.includes(GatewayIntentBits.MessageContent), true);
});
