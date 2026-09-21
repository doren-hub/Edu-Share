import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { humanizeBookmarkDbError } from "@/lib/bookmarks";

export const runtime = "nodejs";

const bodySchema = z.object({
  testId: z.string().uuid(),
  inList: z.boolean(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "id が不正です" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "教材の指定が不正です" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { data: list, error: listError } = await supabase
    .from("bookmark_lists")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (listError) {
    return NextResponse.json(
      { error: humanizeBookmarkDbError(listError.message) || "リストを確認できませんでした" },
      { status: 500 },
    );
  }
  if (!list) {
    return NextResponse.json({ error: "リストが見つかりません" }, { status: 404 });
  }

  const { testId, inList } = parsed.data;

  if (inList) {
    const { data: test, error: testError } = await supabase
      .from("tests")
      .select("id")
      .eq("id", testId)
      .maybeSingle();
    if (testError) {
      return NextResponse.json({ error: "教材を確認できませんでした" }, { status: 500 });
    }
    if (!test) {
      return NextResponse.json({ error: "教材が見つかりません" }, { status: 404 });
    }

    const { error } = await supabase
      .from("bookmark_list_items")
      .upsert(
        { list_id: id, test_id: testId },
        { onConflict: "list_id,test_id", ignoreDuplicates: true },
      );
    if (error) {
      return NextResponse.json(
        { error: humanizeBookmarkDbError(error.message) || "リストに追加できませんでした" },
        { status: 500 },
      );
    }
  } else {
    const { error } = await supabase
      .from("bookmark_list_items")
      .delete()
      .eq("list_id", id)
      .eq("test_id", testId);
    if (error) {
      return NextResponse.json(
        { error: humanizeBookmarkDbError(error.message) || "リストから外せませんでした" },
        { status: 500 },
      );
    }
  }

  await supabase.from("bookmark_lists").update({ updated_at: new Date().toISOString() }).eq("id", id);

  return NextResponse.json({ ok: true, testId, inList });
}
