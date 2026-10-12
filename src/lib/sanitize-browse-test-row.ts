import type { TestRow } from "@/components/TestList";

/**
 * 一覧表示用: 処理失敗（failed）の行からは生の失敗理由をマスクして安全にする。
 * ready かつテキスト未抽出の場合は processing_error を保持してバッジ判定を可能にする。
 */
export function sanitizeBrowseTestRow<T extends { processing_status: string; processing_error?: string | null }>(
  row: T,
): T {
  if (row.processing_status === "failed") {
    return {
      ...row,
      processing_error: null,
    };
  }
  return row;
}

export function sanitizeBrowseTestRows<T extends { processing_status: string; processing_error?: string | null }>(
  rows: T[],
): T[] {
  return rows.map(sanitizeBrowseTestRow);
}
