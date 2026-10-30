import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  looksLikeSlidePdf,
} from "@/lib/pdfs-bucket-upload";
import {
  deleteObjects,
  putObject,
} from "@/lib/object-storage";
import {
  legacyNotebooklmSlidePdfStoragePath,
  notebooklmSlidePdfStoragePath,
} from "@/lib/test-notebooklm-material-paths";
import { processMultipartFileUpload } from "@/lib/multipart-file-stream";

export const runtime = "nodejs";

const MAX_BYTES = 45 * 1024 * 1024;

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
    .select("id, uploaded_by")
    .eq("id", testId)
    .single();

  if (fetchErr || !test) {
    return NextResponse.json({ error: "テストが見つかりません" }, { status: 404 });
  }
  if (!test.uploaded_by) {
    return NextResponse.json({ error: "アップロード者が不明なため登録できません" }, { status: 400 });
  }
  if (test.uploaded_by !== user.id) {
    return NextResponse.json(
      { error: "スライドを登録できるのはアップロードしたユーザーのみです" },
      { status: 403 },
    );
  }

  const storagePath = notebooklmSlidePdfStoragePath(test.uploaded_by, testId);

  const uploadResult = await processMultipartFileUpload(
    req,
    {
      maxBytes: MAX_BYTES,
      maxBytesMessage: `PDF は ${Math.floor(MAX_BYTES / (1024 * 1024))}MB 以下にしてください`,
      missingFileMessage: "PDFファイルが必要です",
      invalidFormatMessage: "スライドは PDF のみアップロードできます",
      fileValidator: looksLikeSlidePdf,
    },
    async (fileStream) => {
      await putObject(storagePath, fileStream, "application/pdf", {
        maxBytes: MAX_BYTES,
      });
    },
  );

  if (!uploadResult.ok) {
    return NextResponse.json(
      {
        error: uploadResult.error,
        ...(uploadResult.details ? { details: uploadResult.details } : {}),
      },
      { status: uploadResult.status },
    );
  }

  try {
    await deleteObjects([legacyNotebooklmSlidePdfStoragePath(test.uploaded_by, testId)]);
  } catch {
    // 旧キーの掃除は登録結果を失敗扱いにしない。
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

  return NextResponse.json({ ok: true, path: storagePath });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  if (!test.uploaded_by) {
    return NextResponse.json({ error: "アップロード者が不明なため削除できません" }, { status: 400 });
  }
  if (test.uploaded_by !== user.id) {
    return NextResponse.json(
      { error: "削除できるのはアップロードしたユーザーのみです" },
      { status: 403 },
    );
  }

  const storagePath = notebooklmSlidePdfStoragePath(test.uploaded_by, testId);
  const legacyPath = legacyNotebooklmSlidePdfStoragePath(test.uploaded_by, testId);
  await deleteObjects([storagePath, legacyPath]);

  const { error: dbErr } = await admin
    .from("tests")
    .update({ notebooklm_slide_pdf_storage_path: null })
    .eq("id", testId);
  if (dbErr) {
    return NextResponse.json(
      { error: "データベースの更新に失敗しました", details: dbErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
