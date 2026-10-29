import { z } from "zod";
import { MAX_INDUSTRIES } from "./paper-industries.ts";
import {
  isExamMetaPicklistCategory,
  isPicklistCategory,
  isSchoolScopedPicklistCategory,
} from "./picklist-categories.ts";

// Kept separate from route handlers so validation tests never load service clients.
export const uuidSchema = z.string().uuid();

export const testPatchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    source_name: z.string().min(1).max(200).optional(),
    document_type: z.enum(["past_exam", "paper"]).optional(),
    exam_department: z.string().min(1).max(120).nullable().optional(),
    exam_subject: z.string().min(1).max(120).nullable().optional(),
    exam_period: z.string().min(1).max(120).nullable().optional(),
    industries: z.array(z.string().min(1).max(120)).max(MAX_INDUSTRIES).optional(),
    publication_year: z.string().max(32).nullable().optional(),
    paper_authors: z.array(z.string().min(1).max(200)).max(24).optional(),
    paper_venue: z.string().max(400).nullable().optional(),
    paper_doi: z.string().max(200).nullable().optional(),
    /** NotebookLM のノートブック URL。空文字でクリア */
    notebooklm_notebook_url: z.string().max(2048).nullable().optional(),
    /** SciSpace のページ URL。空文字でクリア */
    scispace_project_url: z.string().max(2048).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "更新する項目を1つ以上指定してください",
  });

export const paperAskSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "質問を入力してください")
    .max(4000, "質問が長すぎます"),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().max(4000, "やりとりのテキストが長すぎます"),
      }),
    )
    .max(6, "やりとりの件数が多すぎます")
    .optional(),
});

export const startBodySchema = z.object({
  reuseQuestionsFromSessionId: z.string().uuid().optional(),
  /** 過去セッションの設問プールから重み付き無作為抽出（新規 LLM 生成はしない） */
  pickRandomPastSession: z.boolean().optional(),
  /** 誤答した設問のみ過去プールから抽出（通常／CSV は reviewMistakesScope で切替） */
  pickReviewMistakesSession: z.boolean().optional(),
  reviewMistakesScope: z.enum(["standard", "csv"]).optional(),
  /** Prefer NotebookLM CSV question pool over PDF/RAG (same test may have both). */
  useNotebookLmCsvPool: z.boolean().optional(),
  /** クイズ CSV 列と単語帳 CSV 列のどちらから出題するか（useNotebookLmCsvPool より優先） */
  notebookLmCsvPool: z.enum(["quiz", "vocab"]).optional(),
});

export const uploadFormSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    document_type: z.enum(["past_exam", "paper"]),
    school_name: z.string().max(200).optional(),
    expert_name: z.string().max(200).optional(),
    paper_venue: z.string().max(400).optional(),
    paper_doi: z.string().max(200).optional(),
    publication_year: z.string().max(32).optional(),
    exam_department: z.string().max(120).optional(),
    exam_subject: z.string().max(120).optional(),
    exam_period: z.string().max(120).optional(),
  });

export const picklistPostSchema = z
  .object({
    category: z.string().refine(isPicklistCategory, { message: "category が不正です" }),
    value: z.string().trim().min(1, "値を入力してください").max(200, "200文字以内にしてください"),
    scope_school_name: z.union([z.string(), z.null()]).optional(),
    scope_department_value: z.union([z.string(), z.null()]).optional(),
  })
  .superRefine((data, ctx) => {
    const scope =
      data.scope_school_name === null || data.scope_school_name === undefined
        ? ""
        : String(data.scope_school_name).trim();
    const dep =
      data.scope_department_value === null || data.scope_department_value === undefined
        ? ""
        : String(data.scope_department_value).trim();

    if (isExamMetaPicklistCategory(data.category)) {
      if (!scope) {
        ctx.addIssue({
          code: "custom",
          message:
            "科目・テストの時期の候補は学校ごとに追加されます。学校名を選んでから追加してください。",
          path: ["scope_school_name"],
        });
      }
      if (!dep) {
        ctx.addIssue({
          code: "custom",
          message:
            "科目・テストの時期の候補は学科ごとにのみ追加できます（他学科には共有されません）。学科名を選んでから追加してください。",
          path: ["scope_department_value"],
        });
      }
      return;
    }

    if (isSchoolScopedPicklistCategory(data.category)) {
      if (!scope) {
        ctx.addIssue({
          code: "custom",
          message:
            "学科名の候補は学校ごとのみ追加できます（他校と共有されません）。学校名を選んでから追加してください。",
          path: ["scope_school_name"],
        });
      }
      if (dep) {
        ctx.addIssue({
          code: "custom",
          message: "学科名の候補に学科スコープは指定できません",
          path: ["scope_department_value"],
        });
      }
      return;
    }

    if (scope || dep) {
      ctx.addIssue({
        code: "custom",
        message: "このカテゴリでは学校・学科スコープを付けられません",
        path: ["scope_school_name"],
      });
    }
  });

export const quizSubmitSchema = z.object({
  answers: z.record(z.string(), z.union([z.number(), z.string()])),
});

export const bookmarkItemSchema = z.object({
  testId: z.string().uuid(),
  inList: z.boolean(),
});

export const studyStatusSchema = z.object({
  status: z.string(),
});

