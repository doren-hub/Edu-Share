import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  legacyNotebooklmVideoMp4StoragePath,
  notebooklmVideoMp4StoragePath,
} from "@/lib/test-notebooklm-material-paths";
import {
  createObjectUploadUrl,
  deleteObjects,
  getObjectMetadata,
} from "@/lib/object-storage";

export const runtime = "nodejs";

const MAX_BYTES = 200 * 1024 * 1024;
const MIN_BYTES = 20_000;

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
  if (!test.uploaded_by || test.uploaded_by !== user.id) {
    return NextResponse.json(
      { error: "動画を登録できるのはアップロードしたユーザーのみです" },
      { status: 403 },
    );
  }

  const storagePath = notebooklmVideoMp4StoragePath(test.uploaded_by, testId);
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    size?: number;
  };

  if (body.action === "prepare") {
    if (!Number.isFinite(body.size) || (body.size ?? 0) <= 0 || (body.size ?? 0) > MAX_BYTES) {
      return NextResponse.json(
        { error: `動画は ${Math.floor(MAX_BYTES / (1024 * 1024))}MB 以下にしてください` },
        { status: 413 },
      );
    }
    try {
      return NextResponse.json({
        path: storagePath,
        uploadUrl: await createObjectUploadUrl(storagePath, "video/mp4"),
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
    (uploaded.contentType != null && uploaded.contentType !== "video/mp4")
  ) {
    return NextResponse.json(
      {
        error:
          "アップロードされたファイルが見つかりません。もう一度ファイルを選び直してください。",
      },
      { status: 400 },
    );
  }

  const { error: dbErr } = await admin
    .from("tests")
    .update({ notebooklm_video_mp4_storage_path: storagePath })
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
    await deleteObjects([legacyNotebooklmVideoMp4StoragePath(test.uploaded_by, testId)]);
  } catch {
    // 旧キーの掃除は登録結果を失敗扱いにしない。
  }

  return NextResponse.json({ ok: true, path: storagePath });
}
