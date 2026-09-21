"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { BookmarkList } from "@/lib/bookmarks";

export function BookmarkListDetail({ list }: { list: BookmarkList }) {
  const router = useRouter();
  const [name, setName] = useState(list.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function rename(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/bookmarks/${list.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "名前を変更できませんでした");
      return;
    }
    router.refresh();
  }

  async function removeList() {
    if (!window.confirm("このリストを削除します。教材自体は残ります。よろしいですか？")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/bookmarks/${list.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "リストを削除できませんでした");
      return;
    }
    router.push("/bookmarks");
    router.refresh();
  }

  async function removeItem(testId: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/bookmarks/${list.id}/items`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ testId, inList: false }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "外せませんでした");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <form onSubmit={(event) => void rename(event)} className="flex flex-wrap items-end gap-3">
        <label className="min-w-[16rem] flex-1 text-sm text-zinc-700">
          リスト名
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-zinc-900"
            maxLength={80}
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-60"
        >
          名前を変更
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void removeList()}
          className="rounded-md border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-50 disabled:opacity-60"
        >
          リストを削除
        </button>
      </form>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {list.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
          このリストにはまだ教材がありません。論文一覧・過去問一覧・教材の詳細から追加できます。
        </p>
      ) : (
        <ul className="grid gap-3">
          {list.items.map((item) => (
            <li
              key={item.testId}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-zinc-500">
                  {item.documentType === "paper" ? "論文" : "過去問（学校）"}
                  {item.sourceName ? ` · ${item.sourceName}` : ""}
                </p>
                {item.visible ? (
                  <Link
                    href={`/tests/${item.testId}`}
                    className="mt-1 block text-lg font-semibold text-zinc-950 hover:underline"
                  >
                    {item.title}
                  </Link>
                ) : (
                  <p className="mt-1 text-lg font-semibold text-zinc-500">{item.title}</p>
                )}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void removeItem(item.testId)}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50 disabled:opacity-60"
              >
                外す
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
