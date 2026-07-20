import assert from "node:assert/strict";
import test from "node:test";
import { buildMeetingCommand } from "../src/commands.mjs";
import { MeetingCoordinator } from "../src/coordinator.mjs";

test("会議IDを受け取るSlashコマンドはlegacy 7文字と新8文字の両方を許可する", () => {
  const json = buildMeetingCommand().toJSON();
  for (const subcommandName of ["url", "status", "cancel", "invite"]) {
    const subcommand = json.options.find((option) => option.name === subcommandName);
    const id = subcommand?.options?.find((option) => option.name === "id");
    assert.equal(id?.min_length, 7, `${subcommandName}.id min_length`);
    assert.equal(id?.max_length, 8, `${subcommandName}.id max_length`);
  }
});

test("起動時に最新のmeetingコマンド定義を対象Guildへ登録する", async () => {
  const registrations = [];
  const guildId = "guild-example";
  const coordinator = new MeetingCoordinator({
    client: {
      guilds: {
        fetch: async (requestedGuildId) => {
          assert.equal(requestedGuildId, guildId);
          return { commands: { set: async (commands) => { registrations.push(commands); } } };
        },
      },
    },
    store: {},
    interpreter: { configured: false },
    sheetsSync: null,
    config: {
      guildId,
      creatorRoleIds: [],
      personalDefaultReminders: [60, 10],
    },
  });

  await coordinator.registerCommands();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].length, 1);
  assert.equal(registrations[0][0].name, "meeting");
});
