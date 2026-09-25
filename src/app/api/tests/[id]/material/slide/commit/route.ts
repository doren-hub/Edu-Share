import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  legacyNotebooklmSlidePdfStoragePath,
  notebooklmSlidePdfStoragePath,
} from "@/lib/test-notebooklm-material-paths";
import {
  createObjectUploadUrl,
  deleteObjects,
  getObjectMetadata,
} from "@/lib/object-storage";

export const runtime = "nodejs";

const MAX_BYTES = 45 * 1024 * 1024;
const MIN_BYTES = 1_000;

/**
 * R2 への署名付き PUT URL を発行し、アップロード後に実在確認してDBへキーを保存する。
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
    .select("id, uploaded_by, pdf_storage_path")
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
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    size?: number;
  };

  if (body.action === "prepare") {
    if (!Number.isFinite(body.size) || (body.size ?? 0) <= 0 || (body.size ?? 0) > MAX_BYTES) {
      return NextResponse.json(
        { error: `PDF は ${Math.floor(MAX_BYTES / (1024 * 1024))}MB 以下にしてください` },
        { status: 413 },
      );
    }
    try {
      return NextResponse.json({
        path: storagePath,
        uploadUrl: await createObjectUploadUrl(storagePath, "application/pdf"),
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: "R2アップロードURLの発行に失敗しました",
          details: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  }

  let uploaded;
  try {
    uploaded = await getObjectMetadata(storagePath);
  } catch (error) {
    return NextResponse.json(
      {
        error: "R2の確認に失敗しました",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
  if (
    !uploaded.exists ||
    (uploaded.size != null && (uploaded.size < MIN_BYTES || uploaded.size > MAX_BYTES)) ||
    (uploaded.contentType != null && uploaded.contentType !== "application/pdf")
  ) {
    return NextResponse.json(
      {
        error:
          "アップロードされたファイルが見つかりません。もう一度ファイルを選び直してください。",
      },
      { status: 400 },
    );
  }
  if (test.pdf_storage_path) {
    try {
      const original = await getObjectMetadata(test.pdf_storage_path);
      if (original.exists && original.size != null && uploaded.size === original.size) {
        return NextResponse.json(
          { error: "元の論文PDFと同じファイルはスライドとして登録できません" },
          { status: 400 },
        );
      }
    } catch {
      // 元PDFの確認に失敗しても、アップロード済みスライドの登録は継続する。
    }
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

  try {
    await deleteObjects([legacyNotebooklmSlidePdfStoragePath(test.uploaded_by, testId)]);
  } catch {
    // 旧キーの掃除は登録結果を失敗扱いにしない。
  }

  return NextResponse.json({ ok: true, path: storagePath });
}
