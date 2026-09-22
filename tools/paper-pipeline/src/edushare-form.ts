/** Edu Share アップロードフォーム（著者必須など）の判定 */

import { parseYearAuthor } from "./scispace-card.ts";

const SKIP_AUTHOR_VALUES = new Set(["", "選択してください", "その他"]);
/** アップロード画面のデモ選択肢。実著者ではない。 */
const DUMMY_AUTHOR_VALUES = new Set(["A. Einstein", "Albert Einstein", "A. K. Dewdney"]);

export function isDummyAuthorValue(v: string): boolean {
  return DUMMY_AUTHOR_VALUES.has(v.trim());
}

export const SLIDE_MATERIAL_HEADING = "スライド（PDF）";
export const VIDEO_MATERIAL_HEADING = "動画（MP4）";

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
    pickAuthorSelectValue(input.optionValues) ||
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
  if (!fromPaste) {
    const existing = pickAuthorSelectValue(input.optionValues);
    if (existing) return { action: "select", value: existing };
  }
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
    const first = m[1].split(/[,，、;／/]/)[0]?.trim() ?? "";
    if (first.length >= 2) return first.slice(0, 80);
  }
  for (const line of paste.split(/\r?\n/)) {
    const ya = parseYearAuthor(line);
    if (!ya) continue;
    const first = ya.authors.split(/[,，、;／/]/)[0]?.trim() ?? "";
    if (first.length >= 2) return first.slice(0, 80);
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
