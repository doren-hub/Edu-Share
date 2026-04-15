/** picklist_options.category と API の category パラメータ */

export const PICKLIST_CATEGORIES = [
  "school_name",
  "department_name",
  "expert_name",
  "exam_subject",
  "exam_period",
  "paper_industry",
  "publication_year",
] as const;

export type PicklistCategory = (typeof PICKLIST_CATEGORIES)[number];

/** 学校名（source_name と同一表記）で候補を切り替えるカテゴリ */
export const SCHOOL_SCOPED_PICKLIST_CATEGORIES = [
  "department_name",
  "exam_subject",
  "exam_period",
] as const satisfies readonly PicklistCategory[];

export function isSchoolScopedPicklistCategory(
  c: string,
): c is (typeof SCHOOL_SCOPED_PICKLIST_CATEGORIES)[number] {
  return (SCHOOL_SCOPED_PICKLIST_CATEGORIES as readonly string[]).includes(c);
}

/** 科目・時期: 学校に加え学科（tests.exam_department と同一表記）で候補を分ける */
export const EXAM_META_SCOPED_PICKLIST_CATEGORIES = [
  "exam_subject",
  "exam_period",
] as const satisfies readonly PicklistCategory[];

export function isExamMetaPicklistCategory(
  c: string,
): c is (typeof EXAM_META_SCOPED_PICKLIST_CATEGORIES)[number] {
  return (EXAM_META_SCOPED_PICKLIST_CATEGORIES as readonly string[]).includes(c);
}

export function isPicklistCategory(s: string): s is PicklistCategory {
  return (PICKLIST_CATEGORIES as readonly string[]).includes(s);
}
