import test from "node:test";
import assert from "node:assert/strict";
import { GatewayIntentBits, Partials } from "discord.js";
import { MEETING_GATEWAY_INTENTS, MEETING_PARTIALS } from "../src/discord-client.mjs";

test("直接メンションだけを扱うためMessageContent intentを要求しない", () => {
  assert.deepEqual(MEETING_GATEWAY_INTENTS, [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ]);
  assert.deepEqual(MEETING_PARTIALS, [Partials.Channel]);
  assert.equal(MEETING_GATEWAY_INTENTS.includes(GatewayIntentBits.MessageContent), false);
});
