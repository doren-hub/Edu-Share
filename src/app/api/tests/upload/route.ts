import { NextResponse } from "next/server";
import { z } from "zod";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestPdfForTest } from "@/lib/ingest-pdf";
import { joinPaperAuthorsForSourceName } from "@/lib/paper-authors";
import { assertStoredPickWithOther } from "@/lib/picklist-parse";
import { mergePicklistOptionsForSelect } from "@/lib/picklist-merge";
import { fetchPicklistOptionRows } from "@/lib/supabase/picklist-table";
import { normalizePdfFilename } from "@/lib/pdf-filename";
import type { UserRole } from "@/lib/types";

export const runtime = "nodejs";

function looksLikePdf(file: File): boolean {
  if (file.type === "application/pdf") return true;
  const name = file.name?.toLowerCase() ?? "";
  return file.type === "" && name.endsWith(".pdf");
}

function describeTestsInsertError(message: string | undefined, code?: string): string {
  const raw = message ?? "";
  const m = raw.toLowerCase();

  if (code === "23505" || (m.includes("duplicate") && m.includes("pdf_filename"))) {
    return "同じ PDF ファイル名の論文が既にあります";
  }

  /** PostgREST: 列がDBに無い、またはスキーマキャッシュが古い（「schema cache」だけでは判定しない） */
  const looksLikeTestsColumnMissingOrStaleCache =
    (m.includes("could not find") && m.includes("column") && m.includes("tests")) ||
    (m.includes("schema cache") && m.includes("column") && m.includes("tests")) ||
    (m.includes("column") && m.includes("tests") && m.includes("does not exist"));

  if (looksLikeTestsColumnMissingOrStaleCache) {
    return (
      "tests に必要な列（exam_period・exam_subject など）が DB に無いか、PostgREST のスキーマキャッシュが古いです。" +
      "【列が足りない可能性】SQL Editor で supabase/sql_editor_tests_app_columns.sql を Run → 続けて " +
      "sql_editor_reload_postgrest_schema.sql も Run したうえで、1分ほど待ってからブラウザで「PDFアップロード」を開き、もう一度 PDF を選んで送信し直してください（Run 直後にすぐ送ると、まだ列が認識されず同じエラーになることがあります）。" +
      "【全体を整える】代わりに supabase/apply_all_migrations.sql を末尾まで実行してもよいです。" +
      "【それでも同じ】ダッシュボードの Project Settings でインスタンスの再起動を検討するか、Supabase サポートへ。" +
      "参考: https://supabase.com/docs/guides/troubleshooting/refresh-postgrest-schema"
    );
  }

  const looksLikeMissingTestsTable =
    m.includes("public.tests") ||
    m.includes("could not find the table") ||
    (m.includes("relation") && m.includes("tests") && m.includes("does not exist")) ||
    m.includes("undefined_table") ||
    m.includes("42p01");

  if (looksLikeMissingTestsTable) {
    return (
      "データベースに tests テーブルがありません（マイグレーション未実行の可能性が高いです）。" +
      "手順: (1) Supabase → Database → Extensions で「vector」を有効化 " +
      "(2) SQL Editor → New query でリポジトリの supabase/apply_all_migrations.sql をすべて貼り付けて Run " +
      "(3) 数十秒待ってからアプリを再読み込み。Storage にバケット「pdfs」が無い場合は SQL 内の insert かダッシュボードで作成してください。"
    );
  }

  return raw.trim() || "テスト作成に失敗しました";
}

function pickUserRole(meta: User["user_metadata"]): UserRole {
  const r = meta?.role;
  if (
    r === "school_student" ||
    r === "expert" ||
    r === "certification" ||
    r === "general"
  ) {
    return r;
  }
  return "general";
}

/** tests.uploaded_by → profiles(id) のため、既存ユーザーで profiles 欠損している場合に補う */
async function ensureProfileRow(
  admin: ReturnType<typeof createAdminClient>,
  user: User,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (existing) return { ok: true };

  const meta = user.user_metadata ?? {};
  const raw =
    typeof meta.display_name === "string" ? meta.display_name.trim() : "";
  const displayName =
    raw ||
    (user.email?.includes("@") ? user.email.split("@")[0] : null) ||
    "ユーザー";

  const { error } = await admin.from("profiles").insert({
    id: user.id,
    email: user.email ?? null,
    display_name: displayName,
    role: pickUserRole(meta),
  });

  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

const uploadFormSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    document_type: z.enum(["past_exam", "paper"]),
    school_name: z.string().max(200).optional(),
    expert_name: z.string().max(200).optional(),
    paper_venue: z.string().max(400).optional(),
    paper_doi: z.string().max(200).optional(),
    industry: z.string().max(120).optional(),
    publication_year: z.string().max(32).optional(),
    exam_department: z.string().max(120).optional(),
    exam_subject: z.string().max(120).optional(),
    exam_period: z.string().max(120).optional(),
  });

export async function POST(req: Request) {
  try {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "PDFファイルが必要です" }, { status: 400 });
  }
  if (!looksLikePdf(file)) {
    return NextResponse.json({ error: "PDFのみアップロードできます" }, { status: 400 });
  }

  const parsed = uploadFormSchema.safeParse({
    title: String(form.get("title") ?? ""),
    description: form.get("description")
      ? String(form.get("description"))
      : undefined,
    document_type: form.get("document_type")
      ? String(form.get("document_type"))
      : "past_exam",
    school_name: form.get("school_name")
      ? String(form.get("school_name"))
      : undefined,
    expert_name: form.get("expert_name")
      ? String(form.get("expert_name"))
      : undefined,
    paper_venue: form.get("paper_venue")
      ? String(form.get("paper_venue"))
      : undefined,
    paper_doi: form.get("paper_doi") ? String(form.get("paper_doi")) : undefined,
    industry: form.get("industry") ? String(form.get("industry")) : undefined,
    publication_year: form.get("publication_year")
      ? String(form.get("publication_year"))
      : undefined,
    exam_department: form.get("exam_department")
      ? String(form.get("exam_department"))
      : undefined,
    exam_subject: form.get("exam_subject")
      ? String(form.get("exam_subject"))
      : undefined,
    exam_period: form.get("exam_period")
      ? String(form.get("exam_period"))
      : undefined,
  });

  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const custom = parsed.error.errors.find((e) => e.code === "custom");
    const firstIssue = parsed.error.issues[0];
    const hint =
      custom?.message ??
      (firstIssue ? firstIssue.message : "入力が不正です");
    return NextResponse.json(
      {
        error: hint,
        details: flat,
      },
      { status: 400 },
    );
  }

  const d = parsed.data;
  const document_type = d.document_type;
  const source_type = document_type === "paper" ? "expert" : "school";

  const titleFinal = d.title.trim();

  const examDepartmentTrim = (d.exam_department ?? "").trim();
  const examSubjectTrim = (d.exam_subject ?? "").trim();
  const examPeriodTrim = (d.exam_period ?? "").trim();
  const industryTrim = (d.industry ?? "").trim();
  const publicationYearTrim = (d.publication_year ?? "").trim();
  const paperVenueTrim = (d.paper_venue ?? "").trim();
  const paperDoiTrim = (d.paper_doi ?? "").trim();

  let paperAuthorsResolved: string[] = [];
  const paRaw = form.get("paper_authors");
  if (typeof paRaw === "string" && paRaw.trim()) {
    try {
      const j = JSON.parse(paRaw) as unknown;
      if (Array.isArray(j)) {
        paperAuthorsResolved = j.map((x) => String(x).trim()).filter(Boolean);
      }
    } catch {
      /* ignore */
    }
  }
  if (document_type === "paper" && paperAuthorsResolved.length === 0) {
    const legacy = (d.expert_name ?? "").trim();
    if (legacy) paperAuthorsResolved = [legacy];
  }

  let source_name = "未設定";
  if (document_type === "past_exam") {
    source_name = (d.school_name ?? "").trim() || "未設定";
  } else {
    if (paperAuthorsResolved.length === 0) {
      return NextResponse.json(
        { error: "論文では著者を1人以上選択してください" },
        { status: 400 },
      );
    }
    const { rows: expRows } = await fetchPicklistOptionRows("expert_name");
    const expVals = mergePicklistOptionsForSelect(expRows, {
      category: "expert_name",
    }).map((r) => r.value);
    const seen = new Set<string>();
    const next: string[] = [];
    for (const raw of paperAuthorsResolved) {
      const r = assertStoredPickWithOther(raw, expVals, true, "著者");
      if (!r.ok) {
        return NextResponse.json({ error: r.message }, { status: 400 });
      }
      if (seen.has(r.value)) continue;
      seen.add(r.value);
      next.push(r.value);
    }
    paperAuthorsResolved = next;
    source_name = joinPaperAuthorsForSourceName(paperAuthorsResolved);
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      {
        error:
          "サーバー用の Supabase キーが未設定です。.env.local の SUPABASE_SERVICE_ROLE_KEY に、ダッシュボード Settings → API の service_role（秘密）キーを設定し、開発サーバーを再起動してください。",
      },
      { status: 500 },
    );
  }

  const testId = crypto.randomUUID();
  const storagePath = `${user.id}/${testId}.pdf`;

  const profileOk = await ensureProfileRow(admin, user);
  if (!profileOk.ok) {
    return NextResponse.json(
      {
        error:
          "ユーザープロファイルを作成できませんでした。Supabase の SQL でマイグレーション（profiles と on_auth_user_created トリガー）が適用されているか確認してください。",
        details: profileOk.message,
      },
      { status: 500 },
    );
  }

  const pdfFilenameRaw =
    (file.name ?? "").replace(/\\/g, "/").split("/").pop()?.trim().slice(0, 200) ?? "";
  const pdfFilename = pdfFilenameRaw
    ? document_type === "paper"
      ? normalizePdfFilename(pdfFilenameRaw)
      : pdfFilenameRaw
    : null;

  if (document_type === "paper" && pdfFilename) {
    const { data: existingPapers, error: dupLookupErr } = await admin
      .from("tests")
      .select("id,pdf_filename")
      .eq("document_type", "paper")
      .not("pdf_filename", "is", null);
    if (!dupLookupErr) {
      const want = normalizePdfFilename(pdfFilename);
      const hit = (existingPapers ?? []).find(
        (row) =>
          typeof row.pdf_filename === "string" &&
          normalizePdfFilename(row.pdf_filename) === want,
      );
      if (hit?.id) {
        return NextResponse.json(
          {
            error: "同じ PDF ファイル名の論文が既にあります",
            testId: hit.id,
          },
          { status: 409 },
        );
      }
    }
  }

  const insertRow = {
    id: testId,
    title: titleFinal,
    description: (d.description ?? "").trim() || null,
    pdf_storage_path: storagePath,
    source_type,
    source_name,
    document_type,
    exam_department:
      document_type === "past_exam" ? examDepartmentTrim || null : null,
    exam_subject:
      document_type === "past_exam" ? examSubjectTrim || null : null,
    exam_period: document_type === "past_exam" ? examPeriodTrim || null : null,
    industry: document_type === "paper" ? industryTrim || null : null,
    publication_year:
      document_type === "paper" ? publicationYearTrim || null : null,
    paper_doi: document_type === "paper" ? paperDoiTrim || null : null,
    paper_venue: document_type === "paper" ? paperVenueTrim || null : null,
    paper_authors: document_type === "paper" ? paperAuthorsResolved : null,
    uploaded_by: user.id,
    processing_status: "pending",
    pdf_filename: pdfFilename,
  };

  let { data: inserted, error: insErr } = await admin
    .from("tests")
    .insert(insertRow)
    .select("id")
    .single();

  if (insErr && /pdf_filename/i.test(insErr.message ?? "")) {
    const { pdf_filename: _omit, ...withoutName } = insertRow;
    const retry = await admin.from("tests").insert(withoutName).select("id").single();
    inserted = retry.data;
    insErr = retry.error;
  }

  if (insErr || !inserted) {
    return NextResponse.json(
      {
        error: describeTestsInsertError(insErr?.message, insErr?.code),
        details: insErr?.message,
        code: insErr?.code,
      },
      { status: 500 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: upErr } = await admin.storage
    .from("pdfs")
    .upload(storagePath, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (upErr) {
    await admin.from("tests").delete().eq("id", testId);
    const storageHint =
      upErr.message?.trim() ||
      JSON.stringify(upErr, Object.keys(upErr).sort(), 2);
    return NextResponse.json(
      {
        error: "ストレージへのアップロードに失敗しました",
        details: storageHint,
      },
      { status: 500 },
    );
  }

  try {
    await ingestPdfForTest({ testId, storagePath });
  } catch (e) {
    await admin
      .from("tests")
      .update({
        processing_status: "failed",
        processing_error: e instanceof Error ? e.message : "処理に失敗しました",
      })
      .eq("id", testId);

    return NextResponse.json(
      {
        error: "PDFの取り込みに失敗しました",
        details: e instanceof Error ? e.message : String(e),
        testId,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ testId });
  } catch (e) {
    console.error("[api/tests/upload]", e);
    const msg = e instanceof Error ? e.message : String(e);
    const formDataHint =
      /formdata|parse body/i.test(msg)
        ? "\n\n（PDF が大きい場合、Next.js のミドルウェア経由ボディ上限で multipart が切れていることがあります。next.config の experimental.middlewareClientMaxBodySize / serverActions.bodySizeLimit を十分大きくし、開発サーバーを再起動してください。）"
        : "";
    const full = msg + formDataHint;
    return NextResponse.json(
      {
        error: "アップロード処理中にサーバー例外が発生しました",
        details: full.length > 2500 ? `${full.slice(0, 2500)}…` : full,
      },
      { status: 500 },
    );
  }
}
