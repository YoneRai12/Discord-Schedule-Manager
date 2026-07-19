import assert from "node:assert/strict";
import test from "node:test";
import { resolveParticipantSnapshot } from "../src/participant-resolution.mjs";

const defaultTemplate = {
  name: "固定メンバー",
  members: [
    { userId: "member-a", displayName: "メンバーA" },
    { userId: "member-b", displayName: "メンバーB" },
  ],
};

test("指定なしなら既定テンプレートを会議用スナップショットへコピーする", () => {
  const result = resolveParticipantSnapshot({ defaultTemplate });
  assert.equal(result.source, "default_template");
  assert.equal(result.templateName, "固定メンバー");
  assert.equal(result.invitees.length, 2);
});
test("明示参加者・名前付きテンプレート・今回なしの優先順位を固定する", () => {
  assert.equal(resolveParticipantSnapshot({
    explicitInvitees: [{ userId: "member-c", displayName: "メンバーC" }],
    explicitParticipantsFound: true,
    defaultTemplate,
  }).source, "explicit");

  const named = resolveParticipantSnapshot({
    explicitInvitees: [{ userId: "member-c", displayName: "メンバーC" }],
    referencedTemplate: defaultTemplate,
  });
  assert.deepEqual(named.invitees.map((item) => item.userId), ["member-a", "member-b", "member-c"]);

  assert.deepEqual(resolveParticipantSnapshot({ defaultTemplate, disableInvites: true }), {
    invitees: [],
    source: "disabled",
    templateName: null,
  });
});
