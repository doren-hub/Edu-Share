import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookmarkListDetail } from "@/components/BookmarkListDetail";
import { loadBookmarkListById } from "@/lib/bookmarks";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ブックマークリスト｜EduShare",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BookmarkListPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">ブックマーク</h1>
        <p className="text-sm text-zinc-600">
          リストを見るには
          <Link className="mx-1 underline" href="/auth/login">
            ログイン
          </Link>
          してください。
        </p>
      </div>
    );
  }

  const loaded = await loadBookmarkListById(supabase, id);
  if (loaded.error) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        {loaded.error}
      </p>
    );
  }
  if (!loaded.list) notFound();

  return (
    <div className="space-y-6">
      <nav className="text-sm text-zinc-600">
        <Link href="/bookmarks" className="font-medium text-zinc-800 underline-offset-2 hover:underline">
          ブックマーク
        </Link>
      </nav>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">{loaded.list.name}</h1>
        <p className="text-sm text-zinc-600">
          このリストの教材だけを表示しています。追加が新しい順です。
        </p>
      </header>
      <BookmarkListDetail list={loaded.list} />
    </div>
  );
}
