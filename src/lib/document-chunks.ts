import { createAdminClient } from "@/lib/supabase/admin";

/** テスト詳細の黄枠（PDF から本文が取れない旨）と同種の警告か。表示されている間は「テスト開始」を無効にする。 */
export function isPdfBodyTextUnavailableNotice(
  processingError: string | null | undefined,
): boolean {
  if (!processingError?.trim()) return false;
  const m = processingError;
  return (
    m.includes("PDFから本文テキストを自動抽出できませんでした") ||
    m.includes("PDFから本文テキストを読み取れませんでした")
  );
}

/** 「テスト開始」（LLM 新規出題）が可能か */
export function canStartNewAutoQuiz(params: {
  chunkCount: number;
  processingError: string | null | undefined;
}): boolean {
  return (
    params.chunkCount > 0 &&
    !isPdfBodyTextUnavailableNotice(params.processingError)
  );
}

/** 出題用チャンク件数（service role）。未設定時は 0。 */
export async function countDocumentChunksForTest(testId: string): Promise<number> {
  try {
    const admin = createAdminClient();
    const { count, error } = await admin
      .from("document_chunks")
      .select("id", { count: "exact", head: true })
      .eq("test_id", testId);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}
