import type { Metadata } from "next";
import Link from "next/link";
import { BookmarkListsPanel } from "@/components/BookmarkListsPanel";
import { loadBookmarkLists } from "@/lib/bookmarks";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ブックマーク｜EduShare",
  description: "論文と過去問の教材を、名前付きのリストに分けて残せます。",
};

export default async function BookmarksPage() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">ブックマーク</h1>
        <p className="max-w-2xl text-sm text-zinc-600">
          名前を付けたリストを複数作れます。同じ教材を複数のリストに入れられます。リストはログイン中のユーザーだけが見られます。
        </p>
      </header>

      {auth.user ? (
        <SignedInLists />
      ) : (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
          リストを作るには
          <Link className="mx-1 underline" href="/auth/login">
            ログイン
          </Link>
          してください。
        </p>
      )}
    </div>
  );
}

async function SignedInLists() {
  const supabase = await createClient();
  const loaded = await loadBookmarkLists(supabase);
  if (loaded.error) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        {loaded.error}
      </p>
    );
  }
  return <BookmarkListsPanel initialLists={loaded.lists} />;
}
