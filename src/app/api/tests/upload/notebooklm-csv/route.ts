import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseNotebookLmCsv } from "@/lib/notebooklm-csv";

export const runtime = "nodejs";

export async function POST(req: Request) {
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
    return NextResponse.json({ error: "CSV ファイルが必要です" }, { status: 400 });
  }
  const lowerName = (file.name ?? "").toLowerCase();
  const isCsv = file.type.includes("csv") || lowerName.endsWith(".csv");
  if (!isCsv) {
    return NextResponse.json({ error: "CSV のみアップロードできます" }, { status: 400 });
  }

  const title = String(form.get("title") ?? "").trim();
  if (!title) {
    return NextResponse.json({ error: "タイトルは必須です" }, { status: 400 });
  }
  const description = String(form.get("description") ?? "").trim();
  const existingTestId = String(
    form.get("existingTestId") ?? form.get("testId") ?? "",
  ).trim();

  let parsed;
  try {
    parsed = parseNotebookLmCsv(await file.text());
  } catch (e) {
    return NextResponse.json(
      {
        error: "CSV の解析に失敗しました",
        details: e instanceof Error ? e.message : String(e),
      },
      { status: 400 },
    );
  }

  const expectedModeRaw = String(form.get("expectedMode") ?? "")
    .trim()
    .toLowerCase();
  const expectedMode: "quiz" | "flashcard" | null =
    expectedModeRaw === "quiz" || expectedModeRaw === "flashcard"
      ? expectedModeRaw
      : null;
  if (expectedMode && parsed.mode !== expectedMode) {
    return NextResponse.json(
      {
        error:
          expectedMode === "quiz"
            ? "この欄はクイズ（選択式）CSV用です"
            : "この欄は単語帳（Flashcard）CSV用です",
        details:
          expectedMode === "quiz"
            ? "問題・選択肢・正解列がある NotebookLM のクイズ CSV を選んでください。正面／背面形式の単語帳 CSV は右の「単語帳」欄へアップロードしてください。"
            : "正面（問題）・背面（答案）形式の CSV を選んでください。選択肢形式のクイズ CSV は左の「クイズ」欄へアップロードしてください。",
      },
      { status: 400 },
    );
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      { error: "サーバー用の Supabase キーが未設定です" },
      { status: 500 },
    );
  }

  if (existingTestId) {
    const { data: row, error: loadErr } = await admin
      .from("tests")
      .select("id, uploaded_by")
      .eq("id", existingTestId)
      .single();

    if (loadErr || !row) {
      return NextResponse.json(
        { error: "テストが見つかりません", details: loadErr?.message },
        { status: 404 },
      );
    }
    if (row.uploaded_by !== user.id) {
      return NextResponse.json({ error: "このテストを編集する権限がありません" }, { status: 403 });
    }

    const csvPatch =
      parsed.mode === "flashcard"
        ? {
            notebooklm_vocab_questions_json: parsed.questions,
          }
        : {
            notebooklm_questions_json: parsed.questions,
          };

    const { data: updated, error } = await admin
      .from("tests")
      .update({
        title,
        description: description || null,
        processing_status: "ready",
        processing_error: null,
        ...csvPatch,
      })
      .eq("id", existingTestId)
      .select("id")
      .single();

    if (error || !updated) {
      return NextResponse.json(
        { error: "テストの更新に失敗しました", details: error?.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      testId: updated.id,
      questionCount: parsed.questions.length,
      mode: parsed.mode,
      updated: true,
    });
  }

  const testId = crypto.randomUUID();
  const placeholderPdfPath = `${user.id}/${testId}-notebooklm.csv.placeholder.pdf`;
  const csvInsert =
    parsed.mode === "flashcard"
      ? {
          notebooklm_questions_json: null,
          notebooklm_vocab_questions_json: parsed.questions,
        }
      : {
          notebooklm_questions_json: parsed.questions,
          notebooklm_vocab_questions_json: null,
        };
  const { data: inserted, error } = await admin
    .from("tests")
    .insert({
      id: testId,
      title,
      description: description || null,
      pdf_storage_path: placeholderPdfPath,
      source_type: "expert",
      source_name: "NotebookLM",
      paper_authors: ["NotebookLM"],
      paper_venue: null,
      paper_doi: null,
      document_type: "paper",
      uploaded_by: user.id,
      processing_status: "ready",
      processing_error: null,
      quiz_source: "notebooklm_csv",
      ...csvInsert,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    return NextResponse.json(
      { error: "テスト作成に失敗しました", details: error?.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    testId: inserted.id,
    questionCount: parsed.questions.length,
    mode: parsed.mode,
    updated: false,
  });
}
