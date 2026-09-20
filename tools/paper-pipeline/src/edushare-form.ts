/** Edu Share アップロードフォーム（著者必須など）の判定 */

import { parseYearAuthor } from "./scispace-card.ts";

const SKIP_AUTHOR_VALUES = new Set(["", "選択してください", "その他"]);
/** アップロード画面のデモ選択肢。実著者ではない。 */
const DUMMY_AUTHOR_VALUES = new Set(["A. Einstein", "Albert Einstein"]);

export function isDummyAuthorValue(v: string): boolean {
  return DUMMY_AUTHOR_VALUES.has(v.trim());
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
