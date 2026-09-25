import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  looksLikeVideoMp4,
} from "@/lib/pdfs-bucket-upload";
import { deleteObjects, putObject } from "@/lib/object-storage";
import {
  legacyNotebooklmVideoMp4StoragePath,
  notebooklmVideoMp4StoragePath,
} from "@/lib/test-notebooklm-material-paths";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 200 * 1024 * 1024;

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
      { error: "動画を登録できるのはアップロードしたユーザーのみです" },
      { status: 403 },
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "動画ファイルが必要です" }, { status: 400 });
  }
  if (!looksLikeVideoMp4(file)) {
    return NextResponse.json({ error: "動画は MP4 のみアップロードできます" }, { status: 400 });
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    return NextResponse.json(
      { error: `動画は ${Math.floor(MAX_BYTES / (1024 * 1024))}MB 以下にしてください` },
      { status: 413 },
    );
  }

  const storagePath = notebooklmVideoMp4StoragePath(test.uploaded_by, testId);

  try {
    await putObject(storagePath, buf, "video/mp4");
  } catch (error) {
    return NextResponse.json(
      {
        error: "R2へのアップロードに失敗しました",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }

  try {
    await deleteObjects([legacyNotebooklmVideoMp4StoragePath(test.uploaded_by, testId)]);
  } catch {
    // 旧キーの掃除は登録結果を失敗扱いにしない。
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

  const storagePath = notebooklmVideoMp4StoragePath(test.uploaded_by, testId);
  const legacyPath = legacyNotebooklmVideoMp4StoragePath(test.uploaded_by, testId);
  await deleteObjects([storagePath, legacyPath]);

  const { error: dbErr } = await admin
    .from("tests")
    .update({ notebooklm_video_mp4_storage_path: null })
    .eq("id", testId);
  if (dbErr) {
    return NextResponse.json(
      { error: "データベースの更新に失敗しました", details: dbErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
