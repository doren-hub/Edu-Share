/** Edu Share アップロードフォーム（著者必須など）の判定 */

import { parseYearAuthor } from "./scispace-card.ts";

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

/** デモ著者は捨て、SciSpace 貼り付けの先頭名を優先する */
export function choosePaperAuthor(input: {
  current: string;
  optionValues: string[];
  filesPaste: string;
  title: string;
  filename: string;
}): ChosenPaperAuthor {
  const current = input.current.trim();
  const fromPaste = authorFromFilesPaste(input.filesPaste);
  const currentOk = Boolean(current) && current !== "その他" && !isDummyAuthorValue(current);
  if (currentOk && (!fromPaste || authorNamesMatch(current, fromPaste))) {
    return { action: "keep", value: current };
  }
  const wanted =
    fromPaste ||
    fallbackAuthorName({
      filesPaste: input.filesPaste,
      title: input.title,
      filename: input.filename,
    });
  const match = input.optionValues
    .map((v) => v.trim())
    .find(
      (v) =>
        Boolean(v) &&
        !SKIP_AUTHOR_VALUES.has(v) &&
        !v.startsWith("その他") &&
        !isDummyAuthorValue(v) &&
        authorNamesMatch(v, wanted),
    );
  if (match) return { action: "select", value: match };
  return { action: "other", value: wanted };
}

export const FALLBACK_AUTHOR_NAME = "著者未設定";

export function pickAuthorSelectValue(optionValues: string[]): string | null {
  for (const raw of optionValues) {
    const v = raw.trim();
    if (!v || SKIP_AUTHOR_VALUES.has(v) || v.startsWith("その他") || isDummyAuthorValue(v)) continue;
    return v;
  }
  return null;
}

export function authorFromFilesPaste(paste: string): string {
  for (const line of paste.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:authors?|著者(?:名)?)\s*[:：]\s*(.+)$/i);
    if (!m) continue;
    const first = cleanAuthorName(m[1].split(/[,，、;／/]/)[0]?.trim() ?? "");
    if (first.length >= 2 && !isDummyAuthorValue(first)) return first.slice(0, 80);
  }
  for (const line of paste.split(/\r?\n/)) {
    const ya = parseYearAuthor(line);
    if (!ya) continue;
    const first = cleanAuthorName(ya.authors.split(/[,，、;／/]/)[0]?.trim() ?? "");
    if (first.length >= 2 && !isDummyAuthorValue(first)) return first.slice(0, 80);
  }
  return "";
}

export function fallbackAuthorName(input: {
  filesPaste: string;
  title: string;
  filename: string;
}): string {
  const fromPaste = authorFromFilesPaste(input.filesPaste);
  if (fromPaste) return fromPaste;
  return FALLBACK_AUTHOR_NAME;
}

export function isAuthorRequiredError(text: string): boolean {
  return /著者を1人以上/.test(text);
}
