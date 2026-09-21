"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { BookmarkList } from "@/lib/bookmarks";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function BookmarkListsPanel({ initialLists }: { initialLists: BookmarkList[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/bookmarks", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "リストを作成できませんでした");
      return;
    }
    setName("");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(event) => void onCreate(event)}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"
      >
        <label className="min-w-[16rem] flex-1 text-sm text-zinc-700">
          新しいリスト
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-200 px-3 py-2 text-zinc-900"
            maxLength={80}
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          作成
        </button>
      </form>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {initialLists.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
          まだリストがありません。名前を付けて作成できます。中身は空のままでも残せます。
        </p>
      ) : (
        <ul className="grid gap-3">
          {initialLists.map((list) => (
            <li key={list.id}>
              <Link
                href={`/bookmarks/${list.id}`}
                className="block rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-semibold text-zinc-950">{list.name}</h2>
                  <span className="text-sm text-zinc-500">{list.items.length}件</span>
                </div>
                <p className="mt-1 text-xs text-zinc-500">更新 {formatWhen(list.updatedAt)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
