import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isSchoolScopedPicklistCategory } from "@/lib/picklist-categories";
import { createPicklistTableClient } from "@/lib/supabase/picklist-table";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const uuid = z.string().uuid();

export async function DELETE(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!uuid.safeParse(id).success) {
    return NextResponse.json({ error: "id が不正です" }, { status: 400 });
  }

  const userSb = await createClient();
  const { data: auth } = await userSb.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const db = await createPicklistTableClient();

  const { data: row, error: fetchErr } = await db
    .from("picklist_options")
    .select("id,category,scope_school_name")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    return NextResponse.json(
      { error: "候補の確認に失敗しました", details: fetchErr.message },
      { status: 500 },
    );
  }
  if (!row) {
    return NextResponse.json({ error: "候補が見つかりません" }, { status: 404 });
  }

  if (
    isSchoolScopedPicklistCategory(row.category)
    && !(row.scope_school_name ?? "").trim()
  ) {
    return NextResponse.json(
      {
        error:
          "全校共通の候補はここから削除できません（すべての学校のプルダウンに影響します）。",
      },
      { status: 403 },
    );
  }

  const { error } = await db.from("picklist_options").delete().eq("id", id);

  if (error) {
    return NextResponse.json(
      { error: "候補の削除に失敗しました", details: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
