import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  humanizeBookmarkDbError,
  loadBookmarkLists,
  normalizeBookmarkListName,
} from "@/lib/bookmarks";

export const runtime = "nodejs";

async function requireUser() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
}

export async function GET() {
  const { supabase, user } = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  const loaded = await loadBookmarkLists(supabase);
  if (loaded.error) {
    return NextResponse.json({ error: loaded.error }, { status: 500 });
  }
  return NextResponse.json({ lists: loaded.lists });
}

export async function POST(req: Request) {
  const { supabase, user } = await requireUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = normalizeBookmarkListName(body?.name);
  if (!name.ok) {
    return NextResponse.json({ error: name.error }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("bookmark_lists")
    .insert({ user_id: user.id, name: name.name })
    .select("id, name, created_at, updated_at")
    .single();

  if (error || !data) {
    const friendly = error ? humanizeBookmarkDbError(error.message) : "";
    const status = friendly.includes("同じ名前") ? 409 : 500;
    return NextResponse.json(
      { error: friendly || "リストを作成できませんでした" },
      { status },
    );
  }

  return NextResponse.json(
    {
      list: {
        id: data.id,
        name: data.name,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        items: [],
      },
    },
    { status: 201 },
  );
}
