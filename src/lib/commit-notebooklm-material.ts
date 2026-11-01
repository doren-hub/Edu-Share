import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { copyObject, createObjectUploadUrl, deleteObjects, getObjectMetadata } from "@/lib/object-storage";

const formats = {
  slide: { column: "notebooklm_slide_pdf_storage_path", extension: "pdf", type: "application/pdf", min: 1_000, max: 45 * 1024 * 1024 },
  video: { column: "notebooklm_video_mp4_storage_path", extension: "mp4", type: "video/mp4", min: 20_000, max: 200 * 1024 * 1024 },
} as const;

/** Failed cleanup must not roll back a published reference or mask the real error. */
async function cleanup(...keys: Array<string | null | undefined>) {
  try { await deleteObjects(keys); } catch { /* Best effort; see upload protocol documentation. */ }
}

export async function commitNotebooklmMaterial(
  kind: keyof typeof formats,
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: testId } = await ctx.params;
  const format = formats[kind];
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  let admin;
  try { admin = createAdminClient(); } catch {
    return NextResponse.json({ error: "サーバー用の Supabase キーが未設定です" }, { status: 500 });
  }
  const { data: test, error } = await admin.from("tests")
    .select("id, uploaded_by, pdf_storage_path, notebooklm_slide_pdf_storage_path, notebooklm_video_mp4_storage_path").eq("id", testId).single();
  if (error || !test) return NextResponse.json({ error: "テストが見つかりません" }, { status: 404 });
  if (test.uploaded_by !== user.id) {
    return NextResponse.json({ error: "教材を登録できるのはアップロードしたユーザーのみです" }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { action?: string; size?: number; path?: string } | null;
  const prefix = `${user.id}/${testId}-notebooklm-${kind}-`;
  const oldPath: string | null = test[format.column] ?? null;
  if (body?.action === "prepare") {
    if (!Number.isSafeInteger(body.size) || body.size! < format.min || body.size! > format.max) {
      return NextResponse.json({ error: `ファイルは ${format.min} バイト以上 ${format.max / (1024 * 1024)}MB 以下にしてください` }, { status: 413 });
    }
    const path = `${prefix}upload-${randomUUID()}.${format.extension}`;
    try {
      return NextResponse.json({ path, uploadUrl: await createObjectUploadUrl(path, format.type, 15 * 60, body.size) });
    } catch {
      return NextResponse.json({ error: "R2アップロードURLの発行に失敗しました" }, { status: 500 });
    }
  }

  // Only this user's staging namespace is accepted, never a live or arbitrary key.
  const path = body?.path;
  const suffix = typeof path === "string" && path.startsWith(`${prefix}upload-`)
    ? path.slice(`${prefix}upload-`.length) : "";
  const uuid = suffix.slice(0, -(format.extension.length + 1));
  if (body?.action !== "commit" || !path || !suffix.endsWith(`.${format.extension}`) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid) || path === oldPath || path === test.pdf_storage_path) {
    return NextResponse.json({ error: "アップロード先が不正です。ファイルを選び直してください。" }, { status: 400 });
  }

  const destination = `${prefix}${randomUUID()}.${format.extension}`;
  try {
    const uploaded = await getObjectMetadata(path);
    if (!uploaded.exists || uploaded.size == null || uploaded.size < format.min || uploaded.size > format.max ||
        uploaded.contentType !== format.type || !uploaded.etag) {
      await cleanup(path);
      return NextResponse.json({ error: "アップロードされたファイルのサイズまたは形式が不正です" }, { status: 400 });
    }
    if (kind === "slide" && test.pdf_storage_path) {
      const original = await getObjectMetadata(test.pdf_storage_path);
      if (original.exists && original.size === uploaded.size) {
        await cleanup(path);
        return NextResponse.json({ error: "元の論文PDFと同じファイルはスライドとして登録できません" }, { status: 400 });
      }
    }
    // A replayed PUT cannot mutate the published object. If bytes changed since HEAD,
    // the conditional copy fails rather than publishing unvalidated content.
    await copyObject(path, destination, uploaded.etag, format.type);
  } catch {
    await cleanup(path, destination);
    return NextResponse.json({ error: "R2の確認またはコピーに失敗しました" }, { status: 500 });
  }

  // Compare-and-swap prevents concurrent commits from deleting each other's material.
  let update = admin.from("tests").update({ [format.column]: destination })
    .eq("id", testId).eq("uploaded_by", user.id);
  update = oldPath === null ? update.is(format.column, null) : update.eq(format.column, oldPath);
  const { data: changed, error: dbError } = await update.select("id");
  if (dbError || !changed?.length) {
    // A transport error can hide a successful write: retain the immutable copy
    // on uncertain DB outcomes rather than risk deleting a live reference.
    await cleanup(path, dbError ? null : destination);
    return NextResponse.json({ error: "教材の更新に失敗しました。再読み込みしてやり直してください。" }, { status: dbError ? 500 : 409 });
  }

  await cleanup(path, oldPath === test.pdf_storage_path ? null : oldPath);
  return NextResponse.json({ ok: true, path: destination });
}
