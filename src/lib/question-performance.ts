import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnswerMap, StoredQuestion } from "@/lib/types";

const ESSAY_PASS_SCORE = 6;

export function makeQuestionPerformanceKey(
  testId: string,
  q: StoredQuestion,
): string {
  const parts =
    q.type === "multiple_choice"
      ? [
          q.type,
          q.prompt.trim(),
          ...q.options.map((o) => o.trim()),
          String(q.correctIndex),
        ]
      : [q.type, q.prompt.trim(), (q.referenceAnswer ?? "").trim()];
  const payload = [testId, ...parts].join("\u001e");
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 48);
}

function promptExcerpt(q: StoredQuestion): string {
  const t = q.prompt.trim();
  return t.length <= 200 ? t : `${t.slice(0, 197)}…`;
}

/** PDF 照合がある設問のみ、一覧では根拠抜粋を優先する（それ以外は設問文＝prompt） */
function hasPdfEvidenceAnchor(q: StoredQuestion): boolean {
  if (q.type === "multiple_choice") {
    const rects = q.sourcePdfHighlightRects;
    if (Array.isArray(rects) && rects.length > 0) return true;
    return typeof q.sourcePdfPage === "number" && q.sourcePdfPage >= 1;
  }
  const rects = q.sourcePdfHighlightRects;
  if (Array.isArray(rects) && rects.length > 0) return true;
  return typeof q.sourcePdfPage === "number" && q.sourcePdfPage >= 1;
}

function excerptForPerformanceUi(q: StoredQuestion): string {
  if (!hasPdfEvidenceAnchor(q)) {
    return promptExcerpt(q);
  }
  const s = (q.sourceOriginalText ?? q.sourceExcerpt)?.trim();
  if (s && s.length > 0) {
    return s.length <= 200 ? s : `${s.slice(0, 197)}…`;
  }
  return promptExcerpt(q);
}

export function essayScoreFromFeedback(
  feedback: unknown,
  questionId: string,
): number | null {
  if (!feedback || typeof feedback !== "object") return null;
  const essays = (feedback as { essays?: unknown }).essays;
  if (!Array.isArray(essays)) return null;
  for (const row of essays) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    if (o.id === questionId && typeof o.score === "number") {
      return o.score;
    }
  }
  return null;
}

export async function recordQuestionPerformanceAfterSubmit(params: {
  admin: SupabaseClient;
  testId: string;
  userId: string;
  questions: StoredQuestion[];
  answers: AnswerMap;
  feedback: unknown;
}): Promise<void> {
  const { admin, testId, userId, questions, answers, feedback } = params;

  for (const q of questions) {
    const key = makeQuestionPerformanceKey(testId, q);
    const excerpt = excerptForPerformanceUi(q);
    let correct = false;
    if (q.type === "multiple_choice") {
      const a = answers[q.id];
      correct = typeof a === "number" && a === q.correctIndex;
    } else {
      const s = essayScoreFromFeedback(feedback, q.id);
      correct = s !== null && s >= ESSAY_PASS_SCORE;
    }

    const { error } = await admin.rpc("record_question_attempt", {
      p_user_id: userId,
      p_test_id: testId,
      p_question_key: key,
      p_prompt_excerpt: excerpt,
      p_question_type: q.type,
      p_correct: correct,
    });
    if (error) {
      console.error("record_question_attempt failed", error.message);
    }
  }
}

export type QuestionPerformanceRow = {
  question_key: string;
  prompt_excerpt: string;
  question_type: string;
  attempts: number;
  correct_count: number;
  updated_at: string;
};
