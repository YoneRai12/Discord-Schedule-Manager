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

function fetchedMessages(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === "function") return [...value.values()];
  return [value];
}

function hasMeetingInviteComponent(value, prefix, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const customId = value.customId ?? value.custom_id ?? value.data?.custom_id;
  if (typeof customId === "string" && customId.startsWith(prefix)) return true;
  const children = value.components ?? value.data?.components;
  return Array.isArray(children)
    && children.some((child) => hasMeetingInviteComponent(child, prefix, seen));
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

  async humanUser(userId) {
    if (!userId) throw Object.assign(new Error("DM recipient is missing"), { code: "recipient_missing" });
    if (!this.client.users?.fetch) {
      throw Object.assign(new Error("Discord user fetch is unavailable"), { code: "user_fetch_unavailable" });
    }
    const user = await this.client.users.fetch(String(userId));
    if (!user || user.bot || user.system) {
      throw Object.assign(new Error("Recipient is not a human Discord user"), {
        code: "not_human_user",
      });
    }
    return user;
  }

  async sendMeetingInvite({ meeting, recipient, beforeSend = null }) {
    this.assertGuild(meeting?.guildId);
    try {
      const member = await this.currentHumanMember(recipient?.userId);
      const payload = privatePayload(await this.buildInvitePayload(meeting, { recipient }));
      if (beforeSend && !await beforeSend()) {
        throw Object.assign(new Error("Invite send was superseded"), { code: "stale_invite_send" });
      }
      const message = await member.user.send(payload);
      return { messageId: String(message.id) };
    } catch (error) {
      this.logger.warn?.(`[direct-messenger] invite_failed code=${compactErrorCode(error)}`);
      throw error;
    }
  }

  async findMeetingInviteMessages({ meeting, recipient, requireCurrentMember = true, limit = 50 }) {
    this.assertGuild(meeting?.guildId);
    if (!meeting?.id) {
      throw Object.assign(new Error("Meeting id is missing"), { code: "meeting_id_missing" });
    }
    const botUserId = this.client.user?.id;
    if (!botUserId) {
      throw Object.assign(new Error("Bot identity is unavailable"), { code: "bot_identity_missing" });
    }
    try {
      const user = requireCurrentMember
        ? (await this.currentHumanMember(recipient?.userId)).user
        : await this.humanUser(recipient?.userId);
      const channel = await user.createDM();
      const recent = await channel.messages.fetch({
        limit: Math.max(1, Math.min(100, Number(limit) || 50)),
      });
      const prefix = `meeting:rsvp:${meeting.id}:`;
      const matches = [];
      const seen = new Set();
      for (const message of fetchedMessages(recent)) {
        if (!message?.id || String(message.author?.id ?? "") !== String(botUserId)) continue;
        if (!hasMeetingInviteComponent(message, prefix)) continue;
        const messageId = String(message.id);
        if (seen.has(messageId)) continue;
        seen.add(messageId);
        matches.push({ messageId });
      }
      return matches;
    } catch (error) {
      this.logger.warn?.(`[direct-messenger] invite_scan_failed code=${compactErrorCode(error)}`);
      throw error;
    }
  }

  async updateMeetingInvite({ meeting, recipient, messageId, beforeEdit = null }) {
    this.assertGuild(meeting?.guildId);
    if (!messageId) throw Object.assign(new Error("DM message id is missing"), { code: "message_id_missing" });
    try {
      const member = await this.currentHumanMember(recipient?.userId);
      const channel = await member.user.createDM();
      const message = await channel.messages.fetch(String(messageId));
      const payload = privatePayload(await this.buildInvitePayload(meeting, { recipient }));
      if (beforeEdit && !await beforeEdit()) {
        throw Object.assign(new Error("Invite update was superseded"), { code: "stale_invite_update" });
      }
      await message.edit(payload);
      return { messageId: String(message.id) };
    } catch (error) {
      this.logger.warn?.(`[direct-messenger] invite_update_failed code=${compactErrorCode(error)}`);
      throw error;
    }
  }

  async deleteDirectMessage({ meeting = null, guildId = null, recipient = null, userId = null, messageId, beforeDelete = null }) {
    this.assertGuild(meeting?.guildId ?? guildId);
    if (!messageId) throw Object.assign(new Error("DM message id is missing"), { code: "message_id_missing" });
    try {
      const user = await this.humanUser(recipient?.userId ?? userId);
      const channel = await user.createDM();
      const message = await channel.messages.fetch(String(messageId));
      if (beforeDelete && !await beforeDelete()) {
        throw Object.assign(new Error("DM deletion was superseded"), { code: "stale_invite_update" });
      }
      await message.delete();
      return { messageId: String(message.id) };
    } catch (error) {
      this.logger.warn?.(`[direct-messenger] direct_delete_failed code=${compactErrorCode(error)}`);
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
