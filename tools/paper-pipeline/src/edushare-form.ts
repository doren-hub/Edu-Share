/** Edu Share アップロードフォーム（著者必須など）の判定 */

import { parseYearAuthor, YEAR_AUTHOR } from "./scispace-card.ts";
import { isInvalidAuthorValue, isNameSuffix, isValidAuthorName } from "./bibliography.ts";
import { parseFirstPageTitleAndAuthor } from "./content-match.ts";

const SKIP_AUTHOR_VALUES = new Set(["", "選択してください", "その他"]);
/** アップロード画面のデモ選択肢。実著者ではない。 */
const DUMMY_AUTHOR_VALUES = new Set(["A. Einstein", "Albert Einstein", "A. K. Dewdney"]);

export function isDummyAuthorValue(v: string): boolean {
  const t = v.trim();
  return (
    DUMMY_AUTHOR_VALUES.has(t) ||
    /^(?:(?:\.{2,3}|\u2026)\s*)?\+\s*\d+\s*More$/iu.test(t) ||
    /^(?:[\s\-–—·•]+)?Show\s*Less$/iu.test(t)
  );
}

export function cleanAuthorName(name: string): string {
  let t = name
    .replace(/(?:[\s\-–—·•]+)?Show\s*Less\s*$/iu, "")
    .replace(/(?:(?:\.{2,3}|\u2026)\s*)?\+\s*\d+\s*More\s*$/iu, "")
    .replace(/[\s,;]+$/g, "")
    .trim();
  if (
    /^(?:(?:\.{2,3}|\u2026)\s*)?\+\s*\d+\s*More$/iu.test(t) ||
    /^(?:[\s\-–—·•]+)?Show\s*Less$/iu.test(t)
  ) {
    return "";
  }
  return t;
}

export const SLIDE_MATERIAL_HEADING = "スライド（PDF）";
export const VIDEO_MATERIAL_HEADING = "動画（MP4）";

/** 見出しに続く同階層の状態行だけを読む。説明行を飛ばし、入力欄の前で止める。 */
export function notebookLmCsvStatusLine(title: Element): string {
  for (let row = title.nextElementSibling; row; row = row.nextElementSibling) {
    if (row.tagName !== "P") break;
    const text = (row.textContent ?? "").trim();
    if (/^(?:未取り込み|取り込み済み[（(])/.test(text)) return text;
  }
  return "";
}

/** クイズ欄か単語帳欄の本文だけを見て、その種類が取り込み済みか */
export function notebookLmCsvPoolImported(cardText: string): boolean {
  const t = cardText.replace(/\s+/g, " ").trim();
  const m = t.match(/取り込み済み[（(](\d+)問[）)]/);
  return !!m && Number(m[1]) >= 1;
}

/** NotebookLM スライド／動画ブロックの「登録済み / 未登録」 */
export function notebookLmMaterialBlockIsRegistered(blockText: string): boolean {
  const t = blockText.replace(/\s+/g, " ").trim();
  if (/登録済み/.test(t)) return true;
  if (/未登録/.test(t)) return false;
  return false;
}

/** 資料カルーセルの切り替えボタン（「編集する」を開かなくても出る） */
export function materialCarouselShowLabel(heading: string): string {
  return `${heading}を表示`;
}

export function paperMaterialIsRegistered(input: {
  formBlockText: string;
  hasViewerPane: boolean;
}): boolean {
  if (input.hasViewerPane) return true;
  return notebookLmMaterialBlockIsRegistered(input.formBlockText);
}

function authorNamesMatch(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export type ChosenPaperAuthor =
  | { action: "keep"; value: string }
  | { action: "select"; value: string }
  | { action: "other"; value: string };

/** デモ著者は捨て、SciSpace 貼り付けの先頭名または PDF/DOI 補完を優先する */
export function choosePaperAuthor(input: {
  current: string;
  optionValues: string[];
  filesPaste: string;
  title: string;
  filename: string;
  pdfText?: string;
  doiAuthor?: string;
}): ChosenPaperAuthor {
  const current = input.current.trim();
  const fromPaste = authorFromFilesPaste(input.filesPaste, input.title);
  const currentOk =
    Boolean(current) &&
    current !== "その他" &&
    !current.startsWith("その他（") &&
    !isDummyAuthorValue(current) &&
    isValidAuthorName(current, input.title);
  if (currentOk && (!fromPaste || authorNamesMatch(current, fromPaste))) {
    return { action: "keep", value: current };
  }
  const wanted =
    fromPaste ||
    fallbackAuthorName({
      filesPaste: input.filesPaste,
      title: input.title,
      filename: input.filename,
      pdfText: input.pdfText,
      doiAuthor: input.doiAuthor,
    });
  const match = input.optionValues
    .map((v) => v.trim())
    .find(
      (v) =>
        Boolean(v) &&
        !SKIP_AUTHOR_VALUES.has(v) &&
        !v.startsWith("その他") &&
        !isDummyAuthorValue(v) &&
        (v === wanted || isValidAuthorName(v, input.title)) &&
        authorNamesMatch(v, wanted),
    );
  if (match) return { action: "select", value: match };
  return { action: "other", value: wanted };
}

export const FALLBACK_AUTHOR_NAME = "著者未設定";

export function pickAuthorSelectValue(optionValues: string[]): string | null {
  for (const raw of optionValues) {
    const v = raw.trim();
    if (!v || SKIP_AUTHOR_VALUES.has(v) || v.startsWith("その他") || isDummyAuthorValue(v) || !isValidAuthorName(v)) continue;
    return v;
  }
  return null;
}

export function splitAuthors(raw: string): string[] {
  const parts = raw
    .split(/[,，、;；／/\n]/)
    .map((p) => cleanAuthorName(p))
    .filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    if (isNameSuffix(part)) {
      if (result.length > 0) {
        result[result.length - 1] = `${result[result.length - 1]}, ${part}`;
      }
      continue;
    }
    result.push(part);
  }
  return result;
}

/** 従来のパイプラインと同じ方法で先頭著者文字列を取り出す（バリデーション前・監査用。DOI単独等も検出のためそのまま返す） */
export function rawAuthorFromFilesPaste(paste: string): string {
  for (const line of paste.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:authors?|著者(?:名)?)\s*[:：]\s*(.+)$/i);
    if (!m) continue;
    const first = cleanAuthorName(m[1].split(/[,，、;／/]/)[0]?.trim() ?? "");
    if (first.length >= 2 && !isDummyAuthorValue(first)) return first.slice(0, 80);
  }
  for (const line of paste.split(/\r?\n/)) {
    const yaMatch = line.trim().match(YEAR_AUTHOR);
    if (!yaMatch) continue;
    let rawAuthors = yaMatch[2]!
      .replace(
        /^DOI\s*[:：]?\s*(?:https?:\/\/(?:dx\.)?doi\.org\/|10\.\d{4,}\/[^\s\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF65\-–—]+)?\s*[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF65\-–—]?\s*/iu,
        "",
      )
      .trim();
    if (!rawAuthors) rawAuthors = yaMatch[2]!.trim(); // e.g. "DOI" itself
    const first = cleanAuthorName(rawAuthors.split(/[,，、;／/]/)[0]?.trim() ?? "");
    if (first.length >= 2 && !isDummyAuthorValue(first)) return first.slice(0, 80);
  }
  return "";
}

export function authorFromFilesPaste(paste: string, title?: string): string {
  for (const line of paste.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:authors?|著者(?:名)?)\s*[:：]\s*(.+)$/i);
    if (!m) continue;
    const authors = splitAuthors(m[1]);
    for (const a of authors) {
      if (a.length >= 2 && !isDummyAuthorValue(a) && isValidAuthorName(a, title)) {
        return a.slice(0, 80);
      }
    }
  }
  for (const line of paste.split(/\r?\n/)) {
    const ya = parseYearAuthor(line);
    if (!ya) continue;
    const authors = splitAuthors(ya.authors);
    for (const a of authors) {
      if (a.length >= 2 && !isDummyAuthorValue(a) && isValidAuthorName(a, title)) {
        return a.slice(0, 80);
      }
    }
  }
  return "";
}

export function fallbackAuthorName(input: {
  filesPaste: string;
  title: string;
  filename: string;
  pdfText?: string;
  doiAuthor?: string;
}): string {
  const fromPaste = authorFromFilesPaste(input.filesPaste, input.title);
  if (fromPaste) return fromPaste;

  if (input.pdfText) {
    const parsed = parseFirstPageTitleAndAuthor(input.pdfText);
    if (parsed.author && isValidAuthorName(parsed.author, input.title)) {
      return parsed.author.slice(0, 80);
    }
  }

  if (input.doiAuthor && isValidAuthorName(input.doiAuthor, input.title)) {
    return input.doiAuthor.slice(0, 80);
  }

  return FALLBACK_AUTHOR_NAME;
}

export function isAuthorRequiredError(text: string): boolean {
  return /著者を1人以上/.test(text);
}
