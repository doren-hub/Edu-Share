import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  isExamMetaPicklistCategory,
  isPicklistCategory,
  isSchoolScopedPicklistCategory,
} from "@/lib/picklist-categories";
import {
  createPicklistTableClient,
  fetchPicklistOptionRows,
} from "@/lib/supabase/picklist-table";

export const runtime = "nodejs";

function humanizePicklistDbError(message: string): string {
  const m = message.toLowerCase();
  // 「テーブルなし」と「列なし」は両方 "does not exist" を含むため、列名を先に判定する
  if (m.includes("scope_department_value")) {
    return (
      "picklist_options に列 scope_department_value がありません（科目・時期を学科ごとに分けるための列です）。" +
      "Supabase の SQL Editor で、次のいずれかのファイルの内容をすべて貼り付けて Run してください: " +
      "supabase/sql_editor_picklist_department_scope_column.sql（推奨）または " +
      "supabase/migrations/011_exam_subject_period_department_scope.sql（同一内容）。"
    );
  }
  if (m.includes("scope_school_name")) {
    return (
      "picklist_options に列 scope_school_name がありません（アプリは学校別の学科・科目・時期候補に対応済みです）。" +
      "すでにテーブルがある場合は、Supabase の SQL Editor で " +
      "リポジトリの supabase/sql_editor_picklist_scope_only.sql の内容をすべて貼り付けて Run してください。" +
      "（中身は supabase/migrations/008_picklist_scope_school.sql と同じです。実行後にページを再読み込みしてください。）"
    );
  }
  if (
    m.includes("does not exist") ||
    m.includes("schema cache") ||
    m.includes("could not find the table")
  ) {
    return (
      "picklist_options テーブルがありません。Supabase の SQL Editor で " +
      "リポジトリの supabase/sql_editor_picklist_options.sql を開き、内容をすべて貼り付けて Run してください。" +
      "（または apply_all_migrations.sql の picklist ブロック。実行後にページを再読み込みしてください。）"
    );
  }
  if (m.includes("permission denied") || m.includes("42501")) {
    return (
      "picklist_options への権限がありません。007 の GRANT を実行するか、" +
      ".env に SUPABASE_SERVICE_ROLE_KEY（service_role）を設定してください。"
    );
  }
  if (m.includes("invalid api key") || m.includes("jwt expired")) {
    return (
      "Supabase の API キーまたはセッションに問題があります。環境変数とログイン状態を確認してください。"
    );
  }
  return "";
}

/** INSERT / CHECK 失敗（008 のみ済みで学科の学校スコープが DB に未反映のときなど） */
function humanizePicklistConstraintError(message: string): string {
  const m = message.toLowerCase();
  if (
    m.includes("picklist_options_scope_allowed_chk")
    || m.includes("picklist_options_category_check")
    || m.includes("picklist_options_dept_scope_chk")
    || (m.includes("violates check constraint") && m.includes("picklist_options"))
  ) {
    return (
      "picklist_options の制約が現在のアプリと一致していません。" +
      "Supabase の SQL Editor で、順に 009_exam_department_picklist.sql（未なら）、" +
      "011_exam_subject_period_department_scope.sql を実行してください。"
    );
  }
  return "";
}

const postSchema = z
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

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("category");
  if (!raw || !isPicklistCategory(raw)) {
    return NextResponse.json({ error: "category パラメータが必要です" }, { status: 400 });
  }

  const schoolRaw = req.nextUrl.searchParams.get("school");
  const school =
    schoolRaw && schoolRaw.trim().length > 0 ? schoolRaw.trim() : undefined;
  const deptRaw = req.nextUrl.searchParams.get("department");
  const department =
    deptRaw && deptRaw.trim().length > 0 ? deptRaw.trim() : undefined;

  const { rows, error } = await fetchPicklistOptionRows(raw, { school, department });

  if (error) {
    const hint = humanizePicklistDbError(error.message);
    return NextResponse.json(
      {
        error: hint || "候補の取得に失敗しました",
        details: error.message,
        code: error.code,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ items: rows });
}

export async function POST(req: NextRequest) {
  const userSb = await createClient();
  const { data: auth } = await userSb.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const db = await createPicklistTableClient();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 形式の本文が必要です" }, { status: 400 });
  }

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const msg =
      flat.fieldErrors.category?.[0]
      ?? flat.fieldErrors.value?.[0]
      ?? flat.fieldErrors.scope_school_name?.[0]
      ?? flat.fieldErrors.scope_department_value?.[0]
      ?? parsed.error.errors.find((e) => e.code === "custom")?.message
      ?? "入力が不正です";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const { category, value } = parsed.data;
  const scopeNorm =
    parsed.data.scope_school_name === undefined
    || parsed.data.scope_school_name === null
      ? null
      : String(parsed.data.scope_school_name).trim() || null;

  const deptNorm =
    parsed.data.scope_department_value === undefined
    || parsed.data.scope_department_value === null
      ? null
      : String(parsed.data.scope_department_value).trim() || null;

  let maxQ = db
    .from("picklist_options")
    .select("sort_order")
    .eq("category", category);

  if (isExamMetaPicklistCategory(category)) {
    maxQ = maxQ
      .eq("scope_school_name", scopeNorm!)
      .eq("scope_department_value", deptNorm!);
  } else if (isSchoolScopedPicklistCategory(category)) {
    maxQ = maxQ.eq("scope_school_name", scopeNorm!).is("scope_department_value", null);
  } else {
    maxQ = maxQ.is("scope_school_name", null).is("scope_department_value", null);
  }

  const { data: maxRow, error: maxErr } = await maxQ
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxErr) {
    const hint = humanizePicklistConstraintError(maxErr.message);
    return NextResponse.json(
      {
        error: hint || "候補の追加に失敗しました",
        details: maxErr.message,
        code: maxErr.code,
      },
      { status: 500 },
    );
  }

  const sort_order = (maxRow?.sort_order ?? 0) + 1;

  const insertSchool = isSchoolScopedPicklistCategory(category) ? scopeNorm! : null;
  const insertDept = isExamMetaPicklistCategory(category) ? deptNorm! : null;

  const { data: insertedRows, error: insErr } = await db
    .from("picklist_options")
    .insert({
      category,
      value,
      sort_order,
      scope_school_name: insertSchool,
      scope_department_value: insertDept,
    })
    .select("id,value,scope_school_name,scope_department_value");

  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json({ error: "同じ候補が既にあります" }, { status: 409 });
    }
    const hint = humanizePicklistConstraintError(insErr.message);
    return NextResponse.json(
      {
        error: hint || "候補の追加に失敗しました",
        details: insErr.message,
        code: insErr.code,
      },
      { status: 500 },
    );
  }

  const inserted = insertedRows?.[0];
  if (!inserted) {
    return NextResponse.json(
      {
        error: "候補の追加に失敗しました",
        details:
          "挿入後の行が取得できませんでした。picklist_options の RLS・権限を確認してください。",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ item: inserted });
}
