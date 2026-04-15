import { buildStoredOtherValue } from "@/lib/picklist-parse";

/** DB / PostgREST の unknown を著者配列に正規化 */
export function normalizePaperAuthorsFromDb(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter((s) => s.length > 0);
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const j = JSON.parse(raw) as unknown;
      if (Array.isArray(j)) {
        return j.map((x) => String(x).trim()).filter((s) => s.length > 0);
      }
    } catch {
      return [raw.trim()];
    }
  }
  return [];
}

/** tests.source_name（not null）用: 著者を連結して最大 200 文字 */
export function joinPaperAuthorsForSourceName(authors: string[]): string {
  const parts = authors.map((a) => a.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return "未設定";
  const j = parts.join("、");
  if (j.length <= 200) return j;
  return `${j.slice(0, 197)}…`;
}

const MAX_AUTHORS = 24;

/** 貼り付け等: カンマ区切り名を「その他（…）」保存値に（候補照合はしない） */
export function authorNamesFromCommaPaste(raw: string): string[] {
  const parts = raw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out = parts.map((p) => buildStoredOtherValue(p));
  return out.slice(0, MAX_AUTHORS);
}

export { MAX_AUTHORS };

/** 表示用の著者名配列（paper_authors 優先、無ければ source_name を読点・コンマで分割） */
export function paperAuthorNamesForDisplay(
  authors: unknown,
  sourceNameFallback: string,
): string[] {
  const fromDb = normalizePaperAuthorsFromDb(authors);
  if (fromDb.length > 0) return fromDb;
  const fb = sourceNameFallback.trim();
  if (!fb) return [];
  return fb.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
}

/** 一覧・詳細表示用（DB に配列が無い既存行は source_name にフォールバック） */
export function displayPaperAuthorsList(
  authors: unknown,
  sourceNameFallback: string,
): string {
  const a = paperAuthorNamesForDisplay(authors, sourceNameFallback);
  return a.length > 0 ? a.join("、") : sourceNameFallback.trim();
}
