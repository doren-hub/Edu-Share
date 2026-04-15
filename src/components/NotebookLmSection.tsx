"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { NOTEBOOKLM_APP_URL, NOTEBOOKLM_SOURCES_HELP_URL } from "@/lib/notebooklm";

type PrepareJson = {
  signedUrl?: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  error?: string;
};

export function NotebookLmSection({
  testId,
  enabled,
  initialNotebookUrl,
  canEditNotebookUrl,
  materialUpload = null,
  csvUpload = null,
}: {
  testId: string;
  enabled: boolean;
  initialNotebookUrl: string | null;
  canEditNotebookUrl: boolean;
  /** スライド PDF / 動画 MP4 のアップロード（所有者向け） */
  materialUpload?: ReactNode;
  /** NotebookLM CSV から専用テスト作成（所有者向け） */
  csvUpload?: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [notebookUrlDraft, setNotebookUrlDraft] = useState(
    () => initialNotebookUrl ?? "",
  );
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlNote, setUrlNote] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    setNotebookUrlDraft(initialNotebookUrl ?? "");
  }, [initialNotebookUrl]);

  const hasNotebook = Boolean(initialNotebookUrl?.trim());

  async function saveNotebookUrl() {
    if (!canEditNotebookUrl) return;
    setUrlNote(null);
    setUrlBusy(true);
    try {
      const res = await fetch(`/api/tests/${testId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notebooklm_notebook_url: notebookUrlDraft.trim() === "" ? "" : notebookUrlDraft.trim(),
        }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setUrlNote(json?.error || "リンクの保存に失敗しました");
        return;
      }
      setUrlNote("保存しました。");
      router.refresh();
    } catch {
      setUrlNote("リンクの保存に失敗しました");
    } finally {
      setUrlBusy(false);
    }
  }

  async function removeNotebookUrl() {
    if (!canEditNotebookUrl || !initialNotebookUrl) return;
    setUrlNote(null);
    setUrlBusy(true);
    setNotebookUrlDraft("");
    try {
      const res = await fetch(`/api/tests/${testId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebooklm_notebook_url: "" }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setUrlNote(json?.error || "削除に失敗しました");
        setNotebookUrlDraft(initialNotebookUrl);
        return;
      }
      setUrlNote("リンクを削除しました。");
      router.refresh();
    } catch {
      setUrlNote("削除に失敗しました");
      setNotebookUrlDraft(initialNotebookUrl);
    } finally {
      setUrlBusy(false);
    }
  }

  async function copySignedPdfUrl() {
    if (!enabled) return;
    setBusy(true);
    setNote(null);
    setLastUrl(null);
    try {
      const res = await fetch(`/api/tests/${testId}/notebooklm/prepare`, {
        method: "POST",
        credentials: "include",
      });
      const json = (await res.json().catch(() => null)) as PrepareJson | null;
      if (!res.ok || !json?.signedUrl) {
        setNote(json?.error || "一時リンクの取得に失敗しました");
        return;
      }
      setLastUrl(json.signedUrl);
      try {
        await navigator.clipboard.writeText(json.signedUrl);
        const mins = json.expiresInSeconds
          ? Math.round(json.expiresInSeconds / 60)
          : 60;
        setNote(`PDF用の一時URLをクリップボードにコピーしました（約 ${mins} 分で失効します）。`);
      } catch {
        setNote(
          "クリップボードにコピーできませんでした。下の入力欄から手動でコピーしてください。",
        );
      }
    } catch {
      setNote("一時リンクの取得に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  if (!hasNotebook && !canEditNotebookUrl) {
    return null;
  }

  const openNotebookClassName =
    "inline-flex items-center justify-center rounded-md bg-violet-700 px-3 py-2 text-sm font-medium text-white hover:bg-violet-800";

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-4">
      <h3 className="text-sm font-semibold text-violet-950">NotebookLM</h3>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {hasNotebook && initialNotebookUrl ? (
            <a
              href={initialNotebookUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={openNotebookClassName}
            >
              ノートブックを開く
            </a>
          ) : (
            <span className="text-sm text-violet-900/90">
              ノートブックのリンクが未登録です。「編集する」から登録できます。
            </span>
          )}
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="inline-flex items-center justify-center rounded-md border border-violet-300 bg-white px-3 py-2 text-sm font-medium text-violet-950 hover:bg-violet-50"
          >
            {showDetails ? "閉じる" : "編集する"}
          </button>
        </div>
      </div>

      {showDetails ? (
        <div className="mt-4 border-t border-violet-200/80 pt-4">
          <p className="text-sm text-violet-900/90">
            Google NotebookLM で新しいノートブックを作成し、この教材の PDF をソースとして追加できます。
            アプリの閲覧用 URL は NotebookLM から参照できないため、次の「一時 URL」をソースの「リンク」に貼り付けてください。
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={NOTEBOOKLM_APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-md bg-violet-700 px-3 py-2 text-sm font-medium text-white hover:bg-violet-800"
            >
              NotebookLM を開く
            </a>
            <button
              type="button"
              onClick={() => void copySignedPdfUrl()}
              disabled={!enabled || busy}
              className="inline-flex items-center justify-center rounded-md border border-violet-300 bg-white px-3 py-2 text-sm font-medium text-violet-950 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "取得中…" : "PDF の一時 URL をコピー"}
            </button>
          </div>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-violet-900/85">
            <li>「NotebookLM を開く」で新しいノートブックを作成（または既存を開く）</li>
            <li>「ソースを追加」→「リンク」で、コピーした一時 URL を貼り付け</li>
            <li>取り込みが終わるまでしばらく待つ</li>
          </ol>
          {note ? (
            <p className="mt-3 rounded-md border border-violet-200 bg-white/80 p-2 text-sm text-violet-950">
              {note}
            </p>
          ) : null}
          {lastUrl ? (
            <label className="mt-2 block space-y-1 text-xs text-violet-900">
              <span className="font-medium">一時 URL（手動コピー用）</span>
              <input
                readOnly
                className="w-full rounded border border-violet-200 bg-white px-2 py-1.5 font-mono text-[11px] text-zinc-800"
                value={lastUrl}
                onFocus={(e) => e.target.select()}
              />
            </label>
          ) : null}
          <p className="mt-2 text-xs text-violet-800/80">
            一時 URL は有効期限内は URL を知っている人なら誰でも PDF を取得できます。第三者に共有しないでください。
          </p>
          <p className="mt-1 text-xs text-violet-800/80">
            <a
              href={NOTEBOOKLM_SOURCES_HELP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-violet-950"
            >
              NotebookLM ヘルプ: ソースの追加
            </a>
          </p>

          <div className="mt-4 rounded-md border border-violet-200/80 bg-white/70 p-3">
            <p className="text-xs font-medium text-violet-950">ノートブックのリンク</p>
            <p className="mt-1 text-xs text-violet-900/85">
              NotebookLM で開いているノートブックのアドレスバー URL を登録すると、上の「ノートブックを開く」からすぐ開けます。
            </p>
            {!initialNotebookUrl ? (
              <p className="mt-2 text-xs text-violet-800/80">まだ登録されていません。</p>
            ) : null}
            {canEditNotebookUrl ? (
              <div className="mt-2 space-y-2">
                <input
                  type="url"
                  inputMode="url"
                  placeholder="https://notebooklm.google.com/…"
                  value={notebookUrlDraft}
                  onChange={(e) => setNotebookUrlDraft(e.target.value)}
                  className="w-full rounded border border-violet-200 bg-white px-2 py-1.5 text-xs text-zinc-900 placeholder:text-zinc-400"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={urlBusy}
                    onClick={() => void saveNotebookUrl()}
                    className="rounded-md bg-violet-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-800 disabled:opacity-50"
                  >
                    {urlBusy ? "保存中…" : "リンクを保存"}
                  </button>
                  {initialNotebookUrl ? (
                    <button
                      type="button"
                      disabled={urlBusy}
                      onClick={() => void removeNotebookUrl()}
                      className="rounded-md border border-violet-300 bg-white px-3 py-1.5 text-xs font-medium text-violet-950 hover:bg-violet-50 disabled:opacity-50"
                    >
                      リンクを削除
                    </button>
                  ) : null}
                </div>
                {urlNote ? (
                  <p className="text-xs text-violet-900">{urlNote}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          {csvUpload ? <div className="mt-4">{csvUpload}</div> : null}

          {materialUpload ? (
            <div className="mt-4 border-t border-violet-200/80 pt-4">{materialUpload}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
