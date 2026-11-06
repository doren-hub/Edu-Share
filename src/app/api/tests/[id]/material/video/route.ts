import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  looksLikeVideoMp4,
} from "@/lib/pdfs-bucket-upload";
import {
  deleteObjects,
  putObject,
} from "@/lib/object-storage";
import {
  legacyNotebooklmVideoMp4StoragePath,
  notebooklmVideoMp4StoragePath,
} from "@/lib/test-notebooklm-material-paths";
import { processMultipartFileUpload } from "@/lib/multipart-file-stream";

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
    .select("id, uploaded_by, pdf_storage_path, notebooklm_video_mp4_storage_path")
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

  // Never write to a key that an existing reference (or concurrent upload) uses.
  const storagePath = `${test.uploaded_by}/${testId}-notebooklm-video-${randomUUID()}.mp4`;
  const oldPath: string | null = test.notebooklm_video_mp4_storage_path ?? null;
  const cleanup = async (...keys: Array<string | null | undefined>) => {
    try { await deleteObjects(keys.filter(key => key !== test.pdf_storage_path)); } catch {
      // Best effort: never roll back a published reference for a cleanup failure.
    }
  };
  let storageWrite: Promise<void> | undefined;

  const uploadResult = await processMultipartFileUpload(
    req,
    {
      maxBytes: MAX_BYTES,
      maxBytesMessage: `動画は ${Math.floor(MAX_BYTES / (1024 * 1024))}MB 以下にしてください`,
      missingFileMessage: "動画ファイルが必要です",
      invalidFormatMessage: "動画は MP4 のみアップロードできます",
      fileValidator: looksLikeVideoMp4,
    },
    async (fileStream) => {
      storageWrite = putObject(storagePath, fileStream, "video/mp4", {
        maxBytes: MAX_BYTES,
      });
      await storageWrite;
    },
  );

  if (!uploadResult.ok) {
    // A parser failure may arrive while the storage callback is still settling.
    await storageWrite?.catch(() => {});
    await cleanup(storagePath);
    return NextResponse.json(
      {
        error: uploadResult.error,
        ...(uploadResult.details ? { details: uploadResult.details } : {}),
      },
      { status: uploadResult.status },
    );
  }

  let update = admin.from("tests").update({ notebooklm_video_mp4_storage_path: storagePath })
    .eq("id", testId).eq("uploaded_by", user.id);
  update = oldPath === null ? update.is("notebooklm_video_mp4_storage_path", null) : update.eq("notebooklm_video_mp4_storage_path", oldPath);
  const { data: changed, error: dbErr } = await update.select("id");
  if (dbErr || !changed?.length) {
    // An error can hide a successful write. Keep the possibly published object.
    if (!dbErr) await cleanup(storagePath);
    return NextResponse.json(
      { error: "教材の更新に失敗しました。再読み込みしてやり直してください。" },
      { status: dbErr ? 500 : 409 },
    );
  }

  await cleanup(oldPath, notebooklmVideoMp4StoragePath(test.uploaded_by, testId),
    legacyNotebooklmVideoMp4StoragePath(test.uploaded_by, testId));

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
    .select("id, uploaded_by, pdf_storage_path, notebooklm_video_mp4_storage_path")
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

  let update = admin.from("tests").update({ notebooklm_video_mp4_storage_path: null })
    .eq("id", testId).eq("uploaded_by", user.id);
  const oldPath = test.notebooklm_video_mp4_storage_path;
  update = oldPath == null ? update.is("notebooklm_video_mp4_storage_path", null) : update.eq("notebooklm_video_mp4_storage_path", oldPath);
  const { data: changed, error: dbErr } = await update.select("id");
  if (dbErr) {
    return NextResponse.json(
      { error: "データベースの更新に失敗しました", details: dbErr.message },
      { status: 500 },
    );
  }

  if (!changed?.length) {
    return NextResponse.json({ error: "教材が変更されました。再読み込みしてください。" }, { status: 409 });
  }
  try {
    // Never remove the source paper, even if a material key aliases it.
    await deleteObjects([oldPath, storagePath, legacyPath].filter(key => key !== test.pdf_storage_path));
  } catch {
    // The DB reference is already cleared; cleanup is best effort.
  }

  return NextResponse.json({ ok: true });
}
