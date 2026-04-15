import type { PicklistCategory } from "@/lib/picklist-categories";
import { isExamMetaPicklistCategory } from "@/lib/picklist-categories";

/** API の picklist 行（クライアント・サーバー共通） */
export type PicklistItem = {
  id: string;
  value: string;
  scope_school_name?: string | null;
  /** exam_subject / exam_period の学科スコープ（tests.exam_department と同一表記） */
  scope_department_value?: string | null;
};

function rowRankExam(r: PicklistItem, deptCtx: string): number {
  const sh = (r.scope_school_name ?? "").trim();
  const dep = (r.scope_department_value ?? "").trim();
  if (!sh) return 0;
  if (!dep) return 1;
  if (deptCtx && dep === deptCtx) return 2;
  return -1;
}

/**
 * プルダウン用に同一 value を潰す。exam_subject / exam_period は学科ごとに最も具体的な行を優先。
 */
export function mergePicklistOptionsForSelect(
  rows: PicklistItem[],
  mergeCtx?: { category: PicklistCategory; departmentForMerge?: string },
): PicklistItem[] {
  const cat = mergeCtx?.category;
  const deptCtx = (mergeCtx?.departmentForMerge ?? "").trim();

  if (cat && isExamMetaPicklistCategory(cat)) {
    const byVal = new Map<string, PicklistItem>();
    for (const r of rows) {
      const rank = rowRankExam(r, deptCtx);
      if (rank < 0) continue;
      if (!deptCtx && rank > 1) continue;
      const prev = byVal.get(r.value);
      const prevRank = prev ? rowRankExam(prev, deptCtx) : -999;
      if (!prev || rank > prevRank) byVal.set(r.value, r);
    }
    return Array.from(byVal.values()).sort((a, b) =>
      a.value.localeCompare(b.value, "ja"),
    );
  }

  const byVal = new Map<string, PicklistItem>();
  for (const r of rows) {
    const scope = r.scope_school_name ?? null;
    if (!scope) byVal.set(r.value, { ...r, scope_school_name: null });
  }
  for (const r of rows) {
    const scope = r.scope_school_name ?? null;
    if (scope) byVal.set(r.value, { ...r, scope_school_name: scope });
  }
  return Array.from(byVal.values()).sort((a, b) =>
    a.value.localeCompare(b.value, "ja"),
  );
}
