import { isStoredQuestionLike } from "@/lib/is-stored-question";
import {
  countNotebookLmQuizPoolRows,
  countNotebookLmVocabPoolRows,
  getNotebookLmQuizPoolJson,
  getNotebookLmVocabPoolJson,
} from "@/lib/notebooklm-csv";
import { makeQuestionPerformanceKey } from "@/lib/question-performance";
import type { QuestionPerformanceRow } from "@/lib/question-performance";
import {
  inferNotebookLmCsvPoolKindFromQuestions,
  inferQuizSessionMaterialMode,
} from "@/lib/quiz-session-mode";
import type { StoredQuestion } from "@/lib/types";
import {
  computeCsvPoolUnderstandingDisplay,
  type UnderstandingDisplay,
} from "@/lib/understanding-score";

export function resolveNotebookLmCsvPoolKindForSession(row: {
  questions_json: unknown;
  notebook_lm_csv_pool?: string | null;
}): "quiz" | "vocab" | null {
  const raw = row.notebook_lm_csv_pool;
  if (raw === "quiz" || raw === "vocab") return raw;
  return inferNotebookLmCsvPoolKindFromQuestions(row.questions_json);
}

export function partitionNotebookLmCsvSessionsByPool<T extends {
  questions_json: unknown;
  notebook_lm_csv_pool?: string | null;
}>(sessions: T[]): { quiz: T[]; vocab: T[]; unknown: T[] } {
  const quiz: T[] = [];
  const vocab: T[] = [];
  const unknown: T[] = [];
  for (const s of sessions) {
    const p = resolveNotebookLmCsvPoolKindForSession(s);
    if (p === "vocab") vocab.push(s);
    else if (p === "quiz") quiz.push(s);
    else unknown.push(s);
  }
  return { quiz, vocab, unknown };
}

export function splitNotebookLmCsvPerformanceRows(
  testId: string,
  sessions: Array<{
    questions_json: unknown;
    answers_json: unknown;
    notebook_lm_csv_pool?: string | null;
  }>,
  rows: QuestionPerformanceRow[],
): { quiz: QuestionPerformanceRow[]; vocab: QuestionPerformanceRow[] } {
  const { quizKeys, vocabKeys } = buildNotebookLmCsvPoolQuestionKeySets(
    testId,
    sessions,
  );
  return {
    quiz: rows.filter((r) => quizKeys.has(r.question_key)),
    vocab: rows.filter(
      (r) => vocabKeys.has(r.question_key) && !quizKeys.has(r.question_key),
    ),
  };
}

export function buildNotebookLmCsvPoolQuestionKeySets(
  testId: string,
  sessions: Array<{
    questions_json: unknown;
    answers_json: unknown;
    notebook_lm_csv_pool?: string | null;
  }>,
): { quizKeys: Set<string>; vocabKeys: Set<string> } {
  const quizKeys = new Set<string>();
  const vocabKeys = new Set<string>();
  for (const s of sessions) {
    if (s.answers_json == null) continue;
    if (inferQuizSessionMaterialMode(s.questions_json) !== "csv") continue;
    const raw = s.notebook_lm_csv_pool;
    const pool =
      raw === "quiz" || raw === "vocab"
        ? raw
        : inferNotebookLmCsvPoolKindFromQuestions(s.questions_json);
    if (!pool) continue;
    const target = pool === "vocab" ? vocabKeys : quizKeys;
    const qj = s.questions_json;
    if (!Array.isArray(qj)) continue;
    for (const item of qj) {
      if (!isStoredQuestionLike(item)) continue;
      target.add(makeQuestionPerformanceKey(testId, item as StoredQuestion));
    }
  }
  return { quizKeys, vocabKeys };
}

export type NotebookLmCsvUnderstandingBundle = {
  quiz: UnderstandingDisplay;
  vocab: UnderstandingDisplay;
  combined: UnderstandingDisplay;
  quizPoolSize: number;
  vocabPoolSize: number;
};

export function computeNotebookLmCsvUnderstandingBundle(params: {
  testRow: {
    notebooklm_questions_json?: unknown;
    notebooklm_vocab_questions_json?: unknown;
  };
  testId: string;
  performanceRowsCsv: QuestionPerformanceRow[];
  mySessionsCsv: Array<{
    questions_json: unknown;
    answers_json: unknown;
    notebook_lm_csv_pool?: string | null;
  }>;
}): NotebookLmCsvUnderstandingBundle {
  const quizPoolSize = countNotebookLmQuizPoolRows(
    getNotebookLmQuizPoolJson(params.testRow),
  );
  const vocabPoolSize = countNotebookLmVocabPoolRows(
    getNotebookLmVocabPoolJson(params.testRow),
  );

  const { quizKeys, vocabKeys } = buildNotebookLmCsvPoolQuestionKeySets(
    params.testId,
    params.mySessionsCsv,
  );

  const rowsQuiz = params.performanceRowsCsv.filter((r) =>
    quizKeys.has(r.question_key),
  );
  const rowsVocab = params.performanceRowsCsv.filter(
    (r) => vocabKeys.has(r.question_key) && !quizKeys.has(r.question_key),
  );

  return {
    quiz: computeCsvPoolUnderstandingDisplay({
      poolTitle: "クイズ CSV",
      poolSize: quizPoolSize,
      rows: rowsQuiz,
    }),
    vocab: computeCsvPoolUnderstandingDisplay({
      poolTitle: "単語帳 CSV",
      poolSize: vocabPoolSize,
      rows: rowsVocab,
    }),
    combined: computeCsvPoolUnderstandingDisplay({
      poolTitle: "NotebookLM CSV",
      poolSize: quizPoolSize + vocabPoolSize,
      rows: params.performanceRowsCsv,
    }),
    quizPoolSize,
    vocabPoolSize,
  };
}
