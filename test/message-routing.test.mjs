import assert from "node:assert/strict";
import test from "node:test";
import { meetingMessageText } from "../src/message-routing.mjs";

const BOT_ID = "1234567890" + "12345678";
const GUILD_ID = "guild-example";

function storeWithMeeting(messageId = "meeting-card") {
  return {
    getMeetingByMessageId(guildId, channelId, requestedMessageId) {
      if (guildId === GUILD_ID && channelId === "channel-example" && requestedMessageId === messageId) {
        return { id: "ABC1234", status: "active" };
      }
      return null;
    },
  };
}

test("Botメンション後はURLだけでも予定管理入力として渡す", () => {
  const text = meetingMessageText({
    message: {
      guildId: GUILD_ID,
      channelId: "channel-example",
      content: `<@${BOT_ID}> https://calendar.app.google/example-token`,
      mentions: { has: (value) => value === BOT_ID || value?.id === BOT_ID },
    },
    botUserId: BOT_ID,
    configuredGuildId: GUILD_ID,
    store: storeWithMeeting(),
  });
  assert.equal(text, "https://calendar.app.google/example-token");
});

test("会議カードへの返信でもBotメンションなしでは処理しない", () => {
  const text = meetingMessageText({
    message: {
      guildId: GUILD_ID,
      channelId: "channel-example",
      content: "https://meet.google.com/example-room",
      mentions: { has: () => false },
      reference: { messageId: "meeting-card" },
    },
    botUserId: BOT_ID,
    configuredGuildId: GUILD_ID,
    store: storeWithMeeting(),
  });
  assert.equal(text, null);
});

test("通常会話のURLや無関係な返信は勝手に処理しない", () => {
  const base = {
    guildId: GUILD_ID,
    channelId: "channel-example",
    content: "https://meet.google.com/example-room",
    mentions: { has: () => false },
  };
  assert.equal(meetingMessageText({
    message: base,
    botUserId: BOT_ID,
    configuredGuildId: GUILD_ID,
    store: storeWithMeeting(),
  }), null);
  assert.equal(meetingMessageText({
    message: { ...base, reference: { messageId: "other-message" } },
    botUserId: BOT_ID,
    configuredGuildId: GUILD_ID,
    store: storeWithMeeting(),
  }), null);
});
