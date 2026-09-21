import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { humanizeBookmarkDbError, normalizeBookmarkListName } from "@/lib/bookmarks";

export const runtime = "nodejs";

const uuid = z.string().uuid();

type RouteContext = { params: Promise<{ id: string }> };

async function requireOwnedList(id: string) {
  if (!uuid.safeParse(id).success) {
    return { error: NextResponse.json({ error: "id が不正です" }, { status: 400 }) };
  }
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return { error: NextResponse.json({ error: "ログインが必要です" }, { status: 401 }) };
  }
  const { data: row, error } = await supabase
    .from("bookmark_lists")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return {
      error: NextResponse.json(
        { error: humanizeBookmarkDbError(error.message) || "リストを確認できませんでした" },
        { status: 500 },
      ),
    };
  }
  if (!row) {
    return { error: NextResponse.json({ error: "リストが見つかりません" }, { status: 404 }) };
  }
  return { supabase, user: auth.user, row };
}

export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const owned = await requireOwnedList(id);
  if ("error" in owned) return owned.error;

  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = normalizeBookmarkListName(body?.name);
  if (!name.ok) {
    return NextResponse.json({ error: name.error }, { status: 400 });
  }
  if (name.name === owned.row.name) {
    return NextResponse.json({ ok: true, name: owned.row.name });
  }

  const { error } = await owned.supabase
    .from("bookmark_lists")
    .update({ name: name.name })
    .eq("id", id);

  if (error) {
    const friendly = humanizeBookmarkDbError(error.message);
    const status = friendly.includes("同じ名前") ? 409 : 500;
    return NextResponse.json(
      { error: friendly || "リスト名を変更できませんでした" },
      { status },
    );
  }
  return NextResponse.json({ ok: true, name: name.name });
}

export async function DELETE(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const owned = await requireOwnedList(id);
  if ("error" in owned) return owned.error;

  const { error } = await owned.supabase.from("bookmark_lists").delete().eq("id", id);
  if (error) {
    return NextResponse.json(
      { error: humanizeBookmarkDbError(error.message) || "リストを削除できませんでした" },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
