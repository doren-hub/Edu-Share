import type { SupabaseClient } from "@supabase/supabase-js";
import { collectPaperVocabBacksFromTestRow } from "@/lib/notebooklm-csv";

/**
 * 全論文（document_type = paper）テストの単語帳から「裏面」文字列を集め、
 * 単語テストの誤答プールとして共有する。
 */
export async function loadPaperVocabSharedAnswerPool(
  admin: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await admin
    .from("tests")
    .select("notebooklm_vocab_questions_json, notebooklm_questions_json")
    .eq("document_type", "paper")
    .eq("processing_status", "ready");

  if (error) {
    console.warn("[paper-vocab-shared-pool] select failed:", error.message);
    return [];
  }
  const sink = new Set<string>();
  for (const row of data ?? []) {
    for (const b of collectPaperVocabBacksFromTestRow(
      row as {
        notebooklm_vocab_questions_json?: unknown;
        notebooklm_questions_json?: unknown;
      },
    )) {
      sink.add(b);
    }
  }
  return [...sink];
}
