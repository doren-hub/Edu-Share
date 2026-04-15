import { isStoredQuestionLike } from "@/lib/is-stored-question";
import { makeQuestionPerformanceKey } from "@/lib/question-performance";
import type { QuestionPerformanceRow } from "@/lib/question-performance";
import type { StoredQuestion } from "@/lib/types";

/** 詳細ページの「通常 / CSV」切り替え用。セッション保存形式から推定する。 */
export type QuizSessionMaterialMode = "standard" | "csv";

/**
 * セッション保存済みの設問から、NotebookLM のクイズ CSV か単語帳 CSV かを推定する。
 * `quiz_sessions.notebook_lm_csv_pool` が無い既存行向け（新規セッションは DB 値を優先）。
 */
export function inferNotebookLmCsvPoolKindFromQuestions(
  questionsJson: unknown,
): "quiz" | "vocab" | null {
  if (!Array.isArray(questionsJson) || questionsJson.length === 0) return null;
  let mc = 0;
  let vocabLike = 0;
  for (const raw of questionsJson) {
    if (!isStoredQuestionLike(raw)) {
      if (raw && typeof raw === "object" && (raw as { type?: string }).type === "essay") {
        return null;
      }
      continue;
    }
    if (raw.type === "essay") return null;
    if (raw.type !== "multiple_choice") return null;
    mc++;
    const opt = raw.options[raw.correctIndex]?.trim() ?? "";
    const ex = (raw.sourceExcerpt ?? "").trim();
    if (ex && opt && ex === opt) vocabLike++;
  }
  if (mc < 1) return null;
  if (vocabLike >= Math.ceil(mc * 0.75)) return "vocab";
  return "quiz";
}

/** NotebookLM の「クイズ CSV」由来の選択式（単語帳 CSV ではない） */
export function isNotebookLmCsvQuizMcQuestion(q: StoredQuestion): boolean {
  if (q.type !== "multiple_choice") return false;
  if (inferQuizSessionMaterialMode([q]) !== "csv") return false;
  return inferNotebookLmCsvPoolKindFromQuestions([q]) !== "vocab";
}

export function inferQuizSessionMaterialMode(
  questionsJson: unknown,
): QuizSessionMaterialMode {
  if (!Array.isArray(questionsJson) || questionsJson.length === 0) {
    return "standard";
  }
  for (const raw of questionsJson) {
    if (!isStoredQuestionLike(raw)) continue;
    if (raw.type === "essay") return "standard";
    const rects = (raw as { sourcePdfHighlightRects?: unknown })
      .sourcePdfHighlightRects;
    if (Array.isArray(rects) && rects.length > 0) return "standard";
    const page = (raw as { sourcePdfPage?: unknown }).sourcePdfPage;
    if (typeof page === "number" && page >= 1) return "standard";
  }
  return "csv";
}

export function partitionSessionsByMaterialMode<T extends { questions_json: unknown }>(
  sessions: T[],
): { standard: T[]; csv: T[] } {
  const standard: T[] = [];
  const csv: T[] = [];
  for (const s of sessions) {
    if (inferQuizSessionMaterialMode(s.questions_json) === "csv") {
      csv.push(s);
    } else {
      standard.push(s);
    }
  }
  return { standard, csv };
}

/** 提出済みかつ CSV 推定セッションの設問に対応する question_performance キー集合 */
export function buildCsvQuestionPerformanceKeySet(
  testId: string,
  sessions: Array<{ questions_json: unknown; answers_json: unknown }>,
): Set<string> {
  const csvKeys = new Set<string>();
  for (const s of sessions) {
    if (s.answers_json == null) continue;
    if (inferQuizSessionMaterialMode(s.questions_json) !== "csv") continue;
    const qj = s.questions_json;
    if (!Array.isArray(qj)) continue;
    for (const raw of qj) {
      if (!isStoredQuestionLike(raw)) continue;
      csvKeys.add(makeQuestionPerformanceKey(testId, raw as StoredQuestion));
    }
  }
  return csvKeys;
}

/** 通常モード: CSV 専用キー以外を含む（従来データは CSV 側キーが無いためここに残す） */
export function filterQuestionPerformanceForStandardMode(
  rows: QuestionPerformanceRow[],
  csvKeys: Set<string>,
): QuestionPerformanceRow[] {
  return rows.filter((r) => !csvKeys.has(r.question_key));
}

export function filterQuestionPerformanceForCsvMode(
  rows: QuestionPerformanceRow[],
  csvKeys: Set<string>,
): QuestionPerformanceRow[] {
  return rows.filter((r) => csvKeys.has(r.question_key));
}
