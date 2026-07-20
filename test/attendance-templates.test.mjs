import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTemplateReference,
  normalizeTemplateName,
  parseTemplateManagementMessage,
} from "../src/attendance-templates.mjs";

test("日本語の名前付き参加者テンプレート操作をローカル解析する", () => {
  assert.deepEqual(
    parseTemplateManagementMessage("参加者: メンバーA、メンバーB\n「運営定例」というテンプレートとして保存して"),
    { action: "save", name: "運営定例" },
  );
  assert.deepEqual(
    parseTemplateManagementMessage("テンプレート「運営定例」を既定にして"),
    { action: "set_default", name: "運営定例" },
  );
  assert.deepEqual(parseTemplateManagementMessage("テンプレート一覧を見せて"), { action: "list", name: null });
  assert.deepEqual(
    parseTemplateManagementMessage("テンプレート「運営定例」を削除して"),
    { action: "remove", name: "運営定例" },
  );
});

test("会議本文から参加者テンプレート名を分離してAIへ送らない", () => {
  const result = extractTemplateReference("明日20時から会議。参加者テンプレート: 運営定例\nURL: https://example.com");
  assert.equal(result.templateName, "運営定例");
  assert.equal(result.cleanedText.includes("運営定例"), false);
  assert.match(result.cleanedText, /ATTENDANCE_TEMPLATE_REDACTED/u);
});

test("自然なテンプレート語順も登録済み名と照合してAI本文から分離する", () => {
  const quoted = extractTemplateReference(
    "参加者テンプレート「全体定例」を使って明日20時に会議",
    { knownTemplateNames: ["全体定例"] },
  );
  assert.equal(quoted.templateName, "全体定例");
  assert.equal(quoted.cleanedText.includes("全体定例"), false);

  const reversed = extractTemplateReference(
    "全体定例テンプレートを使って明日20時に会議",
    { knownTemplateNames: ["全体定例"] },
  );
  assert.equal(reversed.templateName, "全体定例");
  assert.equal(reversed.cleanedText.includes("全体定例"), false);

  for (const text of [
    "全体定例のメンバーで明日20時に会議",
    "テンプレ全体定例で明日20時に会議",
    "参加者は全体定例テンプレで明日20時に会議",
    "全体定例のテンプレ使って明日20時に会議",
  ]) {
    const result = extractTemplateReference(text, { knownTemplateNames: ["全体定例"] });
    assert.equal(result.templateName, "全体定例", text);
    assert.equal(result.cleanedText.includes("全体定例"), false, text);
    assert.match(result.cleanedText, /ATTENDANCE_TEMPLATE_REDACTED/u, text);
  }
});

test("テンプレート名は公開テンプレートで安全に扱える文字へ制限する", () => {
  assert.equal(normalizeTemplateName("  運営   定例  ").name, "運営 定例");
  assert.throws(() => normalizeTemplateName("@everyone"), /使える/u);
  assert.throws(() => normalizeTemplateName("https://example.com"), /使える/u);
});
