import type { QuestionPerformanceRow } from "@/lib/question-performance";

/** 集計・グループ化に必要な列だけ（API からの部分行でも使える） */
export type ReviewablePerformanceRow = Pick<
  QuestionPerformanceRow,
  "question_key" | "prompt_excerpt" | "question_type" | "attempts" | "correct_count"
>;

/** 同一設問が別 question_key（選択肢の並び替え等）で複数行になっても 1 論理設問としてまとめる */
function logicalQuestionDedupKey(r: ReviewablePerformanceRow): string {
  const ex = r.prompt_excerpt?.trim();
  if (!ex) return `key:${r.question_key}`;
  const norm = ex.replace(/\s+/g, " ").toLowerCase();
  return `${r.question_type}\u001e${norm}`;
}

function aggregatePerformanceGroup(
  rows: ReviewablePerformanceRow[],
): { attempts: number; correct_count: number } {
  let attempts = 0;
  let correct_count = 0;
  for (const r of rows) {
    attempts += r.attempts;
    correct_count += r.correct_count;
  }
  return { attempts, correct_count };
}

/**
 * Review pool: attempts > 0 and correct rate at most 90% (strictly over 90% excluded).
 * Integer check: 10 * correct_count <= 9 * attempts.
 */
export function isAggregatedPerfEligibleForReview(
  attempts: number,
  correct_count: number,
): boolean {
  if (attempts <= 0) return false;
  return 10 * correct_count <= 9 * attempts;
}

function groupPerformanceRowsByLogicalQuestion(
  rows: ReviewablePerformanceRow[],
): Map<string, ReviewablePerformanceRow[]> {
  const groups = new Map<string, ReviewablePerformanceRow[]>();
  for (const r of rows) {
    const k = logicalQuestionDedupKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

/** Whether to show review: any logical question qualifies (aggregated, rate <= 90%). */
export function hasMissesInPerformanceRows(rows: QuestionPerformanceRow[]): boolean {
  const groups = groupPerformanceRowsByLogicalQuestion(rows);
  for (const g of groups.values()) {
    const { attempts, correct_count } = aggregatePerformanceGroup(g);
    if (isAggregatedPerfEligibleForReview(attempts, correct_count)) return true;
  }
  return false;
}

/** Badge count: review-eligible logical questions (aggregated, rate <= 90%). */
export function countMissedQuestionsInPerformanceRows(
  rows: QuestionPerformanceRow[],
): number {
  const groups = groupPerformanceRowsByLogicalQuestion(rows);
  let n = 0;
  for (const g of groups.values()) {
    const { attempts, correct_count } = aggregatePerformanceGroup(g);
    if (isAggregatedPerfEligibleForReview(attempts, correct_count)) n++;
  }
  return n;
}

/** Review API: all question_key in logical groups with rate <= 90% */
export function questionKeysEligibleForReview(rows: ReviewablePerformanceRow[]): Set<string> {
  const groups = groupPerformanceRowsByLogicalQuestion(rows);
  const keys = new Set<string>();
  for (const g of groups.values()) {
    const { attempts, correct_count } = aggregatePerformanceGroup(g);
    if (!isAggregatedPerfEligibleForReview(attempts, correct_count)) continue;
    for (const r of g) keys.add(r.question_key);
  }
  return keys;
}
