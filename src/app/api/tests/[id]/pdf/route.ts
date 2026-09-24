import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestPdfForTest } from "@/lib/ingest-pdf";
import { createObjectReadUrl, putObject } from "@/lib/object-storage";

export const runtime = "nodejs";

/**
 * 公開中のテスト教材（ready）の元PDFを、ログインユーザーに inline 配信する。
 * 認証確認後、R2 の公開 URL または短期署名 URL へリダイレクトする。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: testId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
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

  const { data: test, error: tErr } = await admin
    .from("tests")
    .select("pdf_storage_path, processing_status")
    .eq("id", testId)
    .single();

  if (tErr || !test || test.processing_status !== "ready" || !test.pdf_storage_path) {
    return NextResponse.json({ error: "PDFを表示できません" }, { status: 404 });
  }

  try {
    return NextResponse.redirect(await createObjectReadUrl(test.pdf_storage_path, 3600));
  } catch (error) {
    return NextResponse.json(
      {
        error: "PDFの取得に失敗しました",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

/**
 * アップロードしたユーザーのみ。同一 storage パスに PDF を上書きし、チャンクを取り直す。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: testId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
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

  const { data: test, error: fetchErr } = await admin
    .from("tests")
    .select("uploaded_by, pdf_storage_path")
    .eq("id", testId)
    .single();

  if (fetchErr || !test) {
    return NextResponse.json({ error: "テストが見つかりません" }, { status: 404 });
  }
  if (test.uploaded_by !== user.id) {
    return NextResponse.json(
      { error: "PDFを差し替えられるのはアップロードしたユーザーのみです" },
      { status: 403 },
    );
  }
  const storagePath = test.pdf_storage_path?.trim();
  if (!storagePath) {
    return NextResponse.json(
      { error: "このテストに保存パスが登録されていません" },
      { status: 500 },
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "PDFファイルが必要です" }, { status: 400 });
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "PDFのみアップロードできます" }, { status: 400 });
  }

  const { error: pendErr } = await admin
    .from("tests")
    .update({
      processing_status: "pending",
      processing_error: null,
    })
    .eq("id", testId);
  if (pendErr) {
    return NextResponse.json(
      { error: pendErr.message || "状態の更新に失敗しました" },
      { status: 500 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    await putObject(storagePath, bytes, "application/pdf");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await admin
      .from("tests")
      .update({
        processing_status: "failed",
        processing_error: message || "R2へのアップロードに失敗しました",
      })
      .eq("id", testId);
    return NextResponse.json(
      { error: message || "R2へのアップロードに失敗しました" },
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
        processing_error: e instanceof Error ? e.message : "PDFの取り込みに失敗しました",
      })
      .eq("id", testId);
    return NextResponse.json(
      {
        error: "PDFの取り込みに失敗しました",
        details: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
