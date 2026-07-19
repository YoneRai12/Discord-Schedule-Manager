function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function compactErrorCode(error) {
  const raw = String(error?.code ?? error?.status ?? error?.name ?? "send_failed");
  return raw.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 64) || "send_failed";
}

function privatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new TypeError("DM payload builder returned an invalid payload"), {
      code: "invalid_dm_payload",
    });
  }
  return {
    ...payload,
    // A template or future UI module must never be able to turn a display name
    // or meeting title into an actual @everyone / role / user mention in DM.
    allowedMentions: { parse: [], repliedUser: false },
  };
}

/**
 * Discord-specific DM transport.
 *
 * It intentionally knows nothing about persistence, aliases, templates or
 * scheduling.  Callers provide payload builders and persist only the returned
 * message id.  Discord identifiers and message bodies are never logged here.
 */
export class DiscordDirectMessenger {
  constructor({
    client,
    guildId,
    buildInvitePayload,
    buildReminderPayload,
    logger = console,
  }) {
    if (!client?.guilds?.fetch) throw new TypeError("client.guilds.fetch is required");
    if (!guildId) throw new TypeError("guildId is required");
    this.client = client;
    this.guildId = String(guildId);
    this.buildInvitePayload = requireFunction(buildInvitePayload, "buildInvitePayload");
    this.buildReminderPayload = requireFunction(buildReminderPayload, "buildReminderPayload");
    this.logger = logger;
  }

  assertGuild(guildId) {
    if (String(guildId ?? "") !== this.guildId) {
      throw Object.assign(new Error("DM delivery belongs to another guild"), {
        code: "guild_mismatch",
      });
    }
  }

  async currentHumanMember(userId) {
    if (!userId) throw Object.assign(new Error("DM recipient is missing"), { code: "recipient_missing" });
    const guild = await this.client.guilds.fetch(this.guildId);
    const member = await guild.members.fetch(String(userId));
    if (!member || String(member.guild?.id ?? guild.id) !== this.guildId) {
      throw Object.assign(new Error("Recipient is not a current guild member"), {
        code: "not_guild_member",
      });
    }
    if (!member.user || member.user.bot || member.user.system) {
      throw Object.assign(new Error("Recipient is not a human guild member"), {
        code: "not_human_member",
      });
    }
    return member;
  }

  async sendMeetingInvite({ meeting, recipient }) {
    this.assertGuild(meeting?.guildId);
    try {
      const member = await this.currentHumanMember(recipient?.userId);
      const payload = privatePayload(await this.buildInvitePayload(meeting, { recipient }));
      const message = await member.user.send(payload);
      return { messageId: String(message.id) };
    } catch (error) {
      this.logger.warn?.(`[direct-messenger] invite_failed code=${compactErrorCode(error)}`);
      throw error;
    }
  }

  async sendPersonalReminder(delivery) {
    this.assertGuild(delivery?.guildId ?? delivery?.meeting?.guildId);
    try {
      const userId = delivery?.userId ?? delivery?.recipient?.userId;
      const member = await this.currentHumanMember(userId);
      const payload = privatePayload(await this.buildReminderPayload(delivery));
      const message = await member.user.send(payload);
      return { messageId: String(message.id) };
    } catch (error) {
      this.logger.warn?.(`[direct-messenger] reminder_failed code=${compactErrorCode(error)}`);
      throw error;
    }
  }
}

export const directMessageErrorCode = compactErrorCode;
