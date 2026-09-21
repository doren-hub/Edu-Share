"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { bookmarkIconState, type BookmarkIconState } from "@/lib/bookmark-name";
import type { BookmarkList } from "@/lib/bookmarks";

type ListsResponse = { lists?: BookmarkList[]; error?: string };

async function readJson(res: Response): Promise<ListsResponse & { ok?: boolean; error?: string }> {
  return (await res.json().catch(() => ({}))) as ListsResponse & { error?: string };
}

function listCountFor(lists: BookmarkList[], testId: string): number {
  return lists.filter((list) => list.items.some((item) => item.testId === testId)).length;
}

function bookmarkButtonLabel(state: BookmarkIconState): string {
  if (state === "many") return "複数のリストに入り";
  if (state === "one") return "リスト入り";
  return "リストに追加";
}

function BookmarkGlyph({ state }: { state: BookmarkIconState }) {
  if (state === "many") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px]">
        <path
          d="M9.4 3.5h7.6A1.4 1.4 0 0 1 18.4 4.9V14.2l-.8.45V5.1a.6.6 0 0 0-.6-.6H9.7z"
          fill="currentColor"
        />
        <path
          d="M6 6.8h8.6A1.5 1.5 0 0 1 16.1 8.3V20.4l-5.5-3.15L5.1 20.4V8.3A1.5 1.5 0 0 1 6.6 6.8z"
          fill="currentColor"
        />
      </svg>
    );
  }
  if (state === "one") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px]">
        <path
          d="M7 3.6h10A1.6 1.6 0 0 1 18.6 5.2V21l-6.6-3.8L5.4 21V5.2A1.6 1.6 0 0 1 7 3.6z"
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px]">
      <path
        d="M7 4.25h10a1.25 1.25 0 0 1 1.25 1.25V20.2l-6.25-3.6L5.75 20.2V5.5A1.25 1.25 0 0 1 7 4.25z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BookmarkMenu({
  testId,
  initialListCount,
  compact = false,
}: {
  testId: string;
  initialListCount: number;
  compact?: boolean;
}) {
  const router = useRouter();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<BookmarkList[] | null>(null);
  const [listCount, setListCount] = useState(initialListCount);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const iconState = bookmarkIconState(listCount);
  const label = bookmarkButtonLabel(iconState);

  useEffect(() => {
    setListCount(initialListCount);
  }, [initialListCount]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function loadLists() {
    const res = await fetch("/api/bookmarks", { credentials: "include" });
    const json = await readJson(res);
    if (!res.ok) {
      setError(json.error || "リストを読み込めませんでした");
      setLists([]);
      return;
    }
    const next = json.lists ?? [];
    setLists(next);
    setListCount(listCountFor(next, testId));
    setError(null);
  }

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) await loadLists();
  }

  async function setMembership(listId: string, inList: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/bookmarks/${listId}/items`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ testId, inList }),
    });
    const json = await readJson(res);
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "更新できませんでした");
      return;
    }
    await loadLists();
    router.refresh();
  }

  async function createAndAdd(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const created = await fetch("/api/bookmarks", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const createdJson = (await created.json().catch(() => ({}))) as {
      error?: string;
      list?: { id: string };
    };
    if (!created.ok || !createdJson.list) {
      setBusy(false);
      setError(createdJson.error || "リストを作成できませんでした");
      return;
    }
    const added = await fetch(`/api/bookmarks/${createdJson.list.id}/items`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ testId, inList: true }),
    });
    const addedJson = await readJson(added);
    setBusy(false);
    if (!added.ok) {
      setError(addedJson.error || "リストへ追加できませんでした");
      return;
    }
    setName("");
    await loadLists();
    router.refresh();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        title={label}
        className={
          compact
            ? "inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
            : "inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
        }
        onClick={() => void toggleOpen()}
      >
        <BookmarkGlyph state={iconState} />
      </button>
      {open ? (
        <div
          id={panelId}
          className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-zinc-200 bg-white p-3 text-left shadow-lg"
        >
          <p className="text-xs font-medium text-zinc-500">ブックマークリスト</p>
          {lists === null ? (
            <p className="mt-2 text-xs text-zinc-500">読み込み中…</p>
          ) : lists.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-600">まだリストがありません。</p>
          ) : (
            <ul className="mt-2 max-h-48 space-y-1 overflow-auto">
              {lists.map((list) => {
                const checked = list.items.some((item) => item.testId === testId);
                return (
                  <li key={list.id}>
                    <label className="flex items-start gap-2 text-sm text-zinc-900">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={checked}
                        disabled={busy}
                        onChange={(event) => void setMembership(list.id, event.target.checked)}
                      />
                      <span className="min-w-0 break-words">{list.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <form onSubmit={(event) => void createAndAdd(event)} className="mt-3 space-y-2">
            <label className="block text-xs text-zinc-600">
              新しいリストを作って追加
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1 text-sm text-zinc-900"
                maxLength={80}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
            >
              作成して追加
            </button>
          </form>
          {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
