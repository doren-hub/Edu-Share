import { createAdminClient } from "@/lib/supabase/admin";
import {
  computeThesisChunkCoverage,
  type ThesisChunkCoverageResult,
} from "@/lib/quiz-chunk-coverage";

export type { ThesisChunkCoverageResult };

export async function loadThesisCoverageForUser(params: {
  testId: string;
  userId: string;
}): Promise<
  | { ok: true; stats: ThesisChunkCoverageResult }
  | { ok: false; error: string }
> {
  try {
    const admin = createAdminClient();
    const [{ data: chunkRows, error: cErr }, { data: sessionRows, error: sErr }] =
      await Promise.all([
        admin
          .from("document_chunks")
          .select("id, content")
          .eq("test_id", params.testId),
        admin
          .from("quiz_sessions")
          .select("questions_json")
          .eq("test_id", params.testId)
          .eq("user_id", params.userId),
      ]);

    if (cErr) return { ok: false, error: cErr.message };
    if (sErr) return { ok: false, error: sErr.message };

    const chunks = (chunkRows ?? []).map((r) => ({
      content: String((r as { content?: string }).content ?? ""),
    }));

    const stats = computeThesisChunkCoverage({
      chunks,
      sessions: sessionRows ?? [],
    });
    return { ok: true, stats };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
