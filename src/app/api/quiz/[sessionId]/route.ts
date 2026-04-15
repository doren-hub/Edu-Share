import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  /** RLS 下の delete が 0 件になりがちなので、本人確認後は service role で削除 */
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    const { data, error } = await supabase
      .from("quiz_sessions")
      .delete()
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .select("id");
    if (error) {
      return NextResponse.json(
        { error: error.message || "削除に失敗しました" },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, deleted: (data?.length ?? 0) > 0 });
  }

  const { data: row, error: selErr } = await admin
    .from("quiz_sessions")
    .select("id, user_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (selErr) {
    return NextResponse.json(
      { error: selErr.message || "セッションの確認に失敗しました" },
      { status: 500 },
    );
  }
  if (!row) {
    return NextResponse.json({ ok: true, deleted: false });
  }
  if (row.user_id !== user.id) {
    return NextResponse.json({ error: "削除する権限がありません" }, { status: 403 });
  }

  const { error: delErr } = await admin.from("quiz_sessions").delete().eq("id", sessionId);
  if (delErr) {
    return NextResponse.json(
      { error: delErr.message || "削除に失敗しました" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, deleted: true });
}
