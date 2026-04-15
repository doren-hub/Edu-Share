import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NOTEBOOKLM_APP_URL } from "@/lib/notebooklm";

export const runtime = "nodejs";

/** NotebookLM がソース取得に使える程度の余裕（秒） */
const SIGNED_URL_TTL_SEC = 60 * 60;

/**
 * ログインユーザー向けに、NotebookLM の「リンク」ソース用の PDF 署名付き URL を発行する。
 * （NotebookLM 側は Google のサーバーから取得するため、アプリの Cookie 付き URL は使えない）
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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
    return NextResponse.json({ error: "PDFを利用できません" }, { status: 404 });
  }

  const { data: signed, error: signErr } = await admin.storage
    .from("pdfs")
    .createSignedUrl(test.pdf_storage_path, SIGNED_URL_TTL_SEC);

  if (signErr || !signed?.signedUrl) {
    return NextResponse.json(
      { error: signErr?.message || "署名付き URL の発行に失敗しました" },
      { status: 500 },
    );
  }

  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SEC * 1000).toISOString();

  return NextResponse.json({
    signedUrl: signed.signedUrl,
    expiresAt,
    expiresInSeconds: SIGNED_URL_TTL_SEC,
    notebookLmAppUrl: NOTEBOOKLM_APP_URL,
  });
}
