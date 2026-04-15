import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  legacyNotebooklmSlidePdfStoragePath,
  notebooklmSlidePdfStoragePath,
} from "@/lib/test-notebooklm-material-paths";

export const runtime = "nodejs";

const expectedNameSuffix = "-notebooklm-slide.pdf";

/**
 * ブラウザが Storage に直接アップロードした後、DB にパスだけ保存する（Next のボディ制限を避ける）。
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

  const { data: test, error: fetchErr } = await admin
    .from("tests")
    .select("id, uploaded_by")
    .eq("id", testId)
    .single();

  if (fetchErr || !test) {
    return NextResponse.json({ error: "テストが見つかりません" }, { status: 404 });
  }
  if (!test.uploaded_by || test.uploaded_by !== user.id) {
    return NextResponse.json(
      { error: "スライドを登録できるのはアップロードしたユーザーのみです" },
      { status: 403 },
    );
  }

  const storagePath = notebooklmSlidePdfStoragePath(test.uploaded_by, testId);
  const expectedFileName = `${testId}${expectedNameSuffix}`;

  const { data: listed, error: listErr } = await admin.storage
    .from("pdfs")
    .list(test.uploaded_by, { limit: 1000 });

  if (listErr) {
    return NextResponse.json(
      { error: "ストレージの確認に失敗しました", details: listErr.message },
      { status: 500 },
    );
  }

  const found = listed?.some((f) => f.name === expectedFileName);
  if (!found) {
    return NextResponse.json(
      {
        error:
          "アップロードされたファイルが見つかりません。もう一度ファイルを選び直してください。",
        details: `期待するファイル名: ${expectedFileName}`,
      },
      { status: 400 },
    );
  }

  const { error: dbErr } = await admin
    .from("tests")
    .update({ notebooklm_slide_pdf_storage_path: storagePath })
    .eq("id", testId);
  if (dbErr) {
    return NextResponse.json(
      {
        error:
          "データベースの更新に失敗しました（マイグレーション 017 が未適用の可能性があります）",
        details: dbErr.message,
      },
      { status: 500 },
    );
  }

  await admin.storage
    .from("pdfs")
    .remove([legacyNotebooklmSlidePdfStoragePath(test.uploaded_by, testId)]);

  return NextResponse.json({ ok: true, path: storagePath });
}
