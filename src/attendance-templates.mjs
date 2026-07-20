const TEMPLATE_NAME_PATTERN = /^[\p{L}\p{N}_ -]+$/u;

function cleanCapturedName(value) {
  return String(value ?? "")
    .replace(/\s*(?:を|に|として|という)$/u, "")
    .trim();
}

export function normalizeTemplateName(value) {
  const name = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const length = [...name].length;
  if (length < 2 || length > 40) throw new Error("テンプレート名は2〜40文字で指定してください");
  if (!TEMPLATE_NAME_PATTERN.test(name)) {
    throw new Error("テンプレート名に使えるのは文字・数字・空白・_・-だけです");
  }
  return { name, nameKey: name.toLocaleLowerCase("ja-JP") };
}

function matchName(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    return normalizeTemplateName(cleanCapturedName(match[1])).name;
  }
  return null;
}

export function parseTemplateManagementMessage(rawText) {
  const text = String(rawText ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!/テンプレート/u.test(text)) return null;

  if (/テンプレート(?:の)?一覧|テンプレートを(?:一覧|全部|見せて)|登録済みテンプレート/u.test(text)) {
    return { action: "list", name: null };
  }

  const defaultName = matchName(text, [
    /既定テンプレート\s*(?:は|:|：)\s*[「『"]?([\p{L}\p{N}_ -]{2,40})[」』"]?$/u,
    /テンプレート\s*[「『"]([\p{L}\p{N}_ -]{2,40})[」』"]\s*を\s*(?:既定|デフォルト|いつもの参加者)/u,
  ]);
  if (defaultName && /(?:既定|デフォルト|いつもの参加者)/u.test(text)) {
    return { action: "set_default", name: defaultName };
  }

  const removeName = matchName(text, [
    /テンプレート(?:削除|解除)\s*(?:は|:|：)?\s*[「『"]?([\p{L}\p{N}_ -]{2,40})[」』"]?$/u,
    /テンプレート\s*[「『"]([\p{L}\p{N}_ -]{2,40})[」』"]\s*を\s*(?:削除|消して|解除)/u,
  ]);
  if (removeName && /(?:削除|消して|解除)/u.test(text)) {
    return { action: "remove", name: removeName };
  }

  const saveName = matchName(text, [
    /テンプレート\s*[「『"]([\p{L}\p{N}_ -]{2,40})[」』"]\s*として.{0,500}?(?:保存|登録)/u,
    /[「『"]([\p{L}\p{N}_ -]{2,40})[」』"]\s*(?:という)?\s*テンプレートとして.{0,500}?(?:保存|登録)/u,
    /テンプレート(?:保存|登録)\s*(?:は|:|：)\s*([\p{L}\p{N}_ -]{2,40}?)(?=\s+(?:参加者|出席者)\s*[:：])/u,
    /テンプレート(?:保存|登録)\s*(?:は|:|：)?\s*[「『"]?([\p{L}\p{N}_ -]{2,40})[」』"]?$/u,
    /[「『"]([\p{L}\p{N}_ -]{2,40})[」』"]\s*(?:という)?\s*テンプレート(?:として|に)?\s*(?:保存|登録)/u,
    /(?:^|[。.!！?？]\s*)([\p{L}\p{N}_ -]{2,40})\s*を\s*テンプレート(?:として|に)?\s*(?:保存|登録)/u,
    /テンプレート\s*[「『"]([\p{L}\p{N}_ -]{2,40})[」』"]\s*を\s*(?:保存|登録)/u,
  ]);
  if (saveName && /(?:保存|登録)/u.test(text)) {
    return { action: "save", name: saveName };
  }

  const showName = matchName(text, [
    /テンプレート\s*[「『"]([\p{L}\p{N}_ -]{2,40})[」』"]\s*を\s*(?:見せて|確認|表示)/u,
  ]);
  if (showName) return { action: "show", name: showName };
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function extractTemplateReference(rawText, { knownTemplateNames = [] } = {}) {
  let templateName = null;
  const replaceReference = (_whole, captured) => {
      const normalized = normalizeTemplateName(captured);
      if (templateName && templateName.toLocaleLowerCase("ja-JP") !== normalized.nameKey) {
        throw new Error("参加者テンプレートは1つだけ指定してください");
      }
      templateName = normalized.name;
      return "[ATTENDANCE_TEMPLATE_REDACTED]";
    };
  let cleanedText = String(rawText ?? "").normalize("NFKC").replace(
    /(?:参加者|出席者)?テンプレート\s*[「『"]([^」』"\r\n]{2,40})[」』"]\s*(?:を)?\s*使(?:う|って)/giu,
    replaceReference,
  );
  cleanedText = cleanedText.replace(
    /(?:参加者|出席者)?テンプレート\s*(?:は|:|：)\s*[「『"]([^」』"\r\n]{2,40})[」』"]/giu,
    replaceReference,
  );
  cleanedText = cleanedText.replace(
    /(?:参加者|出席者)?テンプレート\s*(?:は|:|：)\s*([\p{L}\p{N}_ -]{2,40}?)(?=\s+(?:URL|リンク)\s*[:：]|\s+で(?:\s|会議|登録|作成|お願い)|\s+を使(?:う|って)|[\r\n。.!！?？]|$)/giu,
    replaceReference,
  );
  const normalizedKnownNames = [...new Set((knownTemplateNames || []).map((name) => (
    normalizeTemplateName(name).name
  )))].sort((left, right) => [...right].length - [...left].length);
  for (const name of normalizedKnownNames) {
    const escaped = escapeRegExp(name);
    for (const pattern of [
      new RegExp(`(?:参加者|出席者)?テンプレート\\s*[「『"]?(${escaped})[」』"]?\\s*(?:を)?\\s*使(?:う|って)`, "giu"),
      new RegExp(`(${escaped})\\s*(?:参加者|出席者)?テンプレート\\s*を\\s*使(?:う|って)`, "giu"),
      new RegExp(`(${escaped})\\s*の\\s*(?:メンバー|参加者|出席者)\\s*(?:で|を|に)?`, "giu"),
      new RegExp(`テンプレ(?:ート)?\\s*[「『"]?(${escaped})[」』"]?\\s*(?:で|を?\\s*使(?:う|って))`, "giu"),
      new RegExp(`(?:参加者|出席者)\\s*(?:は|:|：)\\s*[「『"]?(${escaped})[」』"]?\\s*テンプレ(?:ート)?\\s*(?:で|を?\\s*使(?:う|って))?`, "giu"),
      new RegExp(`(${escaped})\\s*の\\s*テンプレ(?:ート)?\\s*(?:を)?\\s*使(?:う|って)`, "giu"),
    ]) {
      cleanedText = cleanedText.replace(pattern, replaceReference);
    }
  }
  return { cleanedText, templateName, found: Boolean(templateName) };
}
