import type { PicklistCategory } from "@/lib/picklist-categories";
import { isExamMetaPicklistCategory } from "@/lib/picklist-categories";
import { mergePicklistOptionsForSelect, type PicklistItem } from "@/lib/picklist-merge";

/** クライアントから候補の value 一覧を取得（送信前バリデーション用） */
export async function fetchPicklistValues(
  category: PicklistCategory,
  options?: { school?: string; department?: string },
): Promise<string[]> {
  const params = new URLSearchParams({ category });
  const s = options?.school?.trim();
  if (s) params.set("school", s);
  const d = options?.department?.trim();
  if (d && isExamMetaPicklistCategory(category)) {
    params.set("department", d);
  }
  const res = await fetch(`/api/picklists?${params}`, {
    credentials: "include",
  });
  const j = (await res.json()) as {
    items?: PicklistItem[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(j.error || "候補の取得に失敗しました");
  }
  return mergePicklistOptionsForSelect(j.items ?? [], {
    category,
    departmentForMerge: isExamMetaPicklistCategory(category)
      ? options?.department
      : undefined,
  }).map((i) => i.value);
}
