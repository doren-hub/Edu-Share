import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 認証ユーザーの JWT でアップロード（RLS 適合）→ 失敗時は service role で再試行。
 */
export async function uploadPdfsObjectUserThenAdmin(
  userSb: SupabaseClient,
  adminSb: SupabaseClient,
  path: string,
  data: Uint8Array,
  contentType: string,
): Promise<{ error: string | null }> {
  const first = await userSb.storage.from("pdfs").upload(path, data, {
    contentType,
    upsert: true,
  });
  if (!first.error) return { error: null };

  const second = await adminSb.storage.from("pdfs").upload(path, data, {
    contentType,
    upsert: true,
  });
  if (!second.error) return { error: null };

  return {
    error: `storage: ${first.error.message}（ユーザー） / ${second.error.message}（サービス）`,
  };
}

export function looksLikeSlidePdf(file: File): boolean {
  const t = (file.type ?? "").toLowerCase();
  const name = file.name?.toLowerCase() ?? "";
  if (name.endsWith(".pdf")) return true;
  return t === "application/pdf" || t.startsWith("application/pdf");
}

export function looksLikeVideoMp4(file: File): boolean {
  const t = (file.type ?? "").toLowerCase();
  const name = file.name?.toLowerCase() ?? "";
  if (name.endsWith(".mp4")) return true;
  return t === "video/mp4" || t.startsWith("video/mp4");
}
