"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  SciSpacePaperMetadataPaste,
  type SciSpacePaperMetadataInitial,
} from "@/components/SciSpacePaperMetadataPaste";
import type { DocumentType } from "@/lib/types";
import { SCISPACE_CHAT_PDF_URL } from "@/lib/scispace";

export function SciSpaceSection({
  testId,
  initialProjectUrl,
  canEditProjectUrl,
  documentType = "past_exam",
  paperMetaInitial,
}: {
  testId: string;
  initialProjectUrl: string | null;
  canEditProjectUrl: boolean;
  documentType?: DocumentType;
  paperMetaInitial?: SciSpacePaperMetadataInitial | null;
}) {
  const router = useRouter();
  const [urlDraft, setUrlDraft] = useState(() => initialProjectUrl ?? "");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlNote, setUrlNote] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  /** refresh 完了前にヘッダー・「SciSpace を開く」と同期する（null = サーバー値のみ） */
  const [optimisticSavedUrl, setOptimisticSavedUrl] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setUrlDraft(initialProjectUrl ?? "");
  }, [initialProjectUrl]);

  const serverSavedUrl = (initialProjectUrl ?? "").trim();
  const savedUrl =
    optimisticSavedUrl !== null ? optimisticSavedUrl.trim() : serverSavedUrl;
  const hasUrl = Boolean(savedUrl);
  const openHref = hasUrl ? savedUrl : SCISPACE_CHAT_PDF_URL;

  useEffect(() => {
    if (optimisticSavedUrl === null) return;
    if (serverSavedUrl === optimisticSavedUrl.trim()) {
      setOptimisticSavedUrl(null);
    }
  }, [serverSavedUrl, optimisticSavedUrl]);

  if (!hasUrl && !canEditProjectUrl) {
    return null;
  }

  async function saveProjectUrl() {
    if (!canEditProjectUrl) return;
    setUrlNote(null);
    setUrlBusy(true);
    try {
      const res = await fetch(`/api/tests/${testId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scispace_project_url: urlDraft.trim() === "" ? "" : urlDraft.trim(),
        }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setUrlNote(json?.error || "リンクの保存に失敗しました");
        return;
      }
      const next = urlDraft.trim();
      setOptimisticSavedUrl(next);
      setUrlNote("保存しました。");
      router.refresh();
    } catch {
      setUrlNote("リンクの保存に失敗しました");
    } finally {
      setUrlBusy(false);
    }
  }

  async function removeProjectUrl() {
    if (!canEditProjectUrl || !savedUrl) return;
    setUrlNote(null);
    setUrlBusy(true);
    setUrlDraft("");
    try {
      const res = await fetch(`/api/tests/${testId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scispace_project_url: "" }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setUrlNote(json?.error || "削除に失敗しました");
        setUrlDraft(initialProjectUrl ?? "");
        return;
      }
      setOptimisticSavedUrl("");
      setUrlNote("リンクを削除しました。");
      router.refresh();
    } catch {
      setUrlNote("削除に失敗しました");
      setUrlDraft(initialProjectUrl ?? "");
    } finally {
      setUrlBusy(false);
    }
  }

  const primaryBtn =
    "inline-flex items-center justify-center rounded-md bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-800";

  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50/40 p-4">
      <h3 className="text-sm font-semibold text-sky-950">SciSpace</h3>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
          <a
            href={openHref}
            target="_blank"
            rel="noopener noreferrer"
            className={primaryBtn}
          >
            SciSpace を開く
          </a>
          {!hasUrl ? (
            <span className="text-sm text-sky-900/90">
              作業中のページ URL が未登録です。「編集する」から登録できます。
            </span>
          ) : null}
        </div>
        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="inline-flex items-center justify-center rounded-md border border-sky-300 bg-white px-3 py-2 text-sm font-medium text-sky-950 hover:bg-sky-50"
          >
            {showDetails ? "閉じる" : "編集する"}
          </button>
        </div>
      </div>

      {showDetails ? (
        <div className="mt-4 border-t border-sky-200/80 pt-4">
          <p className="text-sm text-sky-900/90">
            SciSpace では論文 PDF の要約・質疑応答・引用付きの説明などが利用できます。
            このアプリへの CSV 取り込みやスライド／動画のアップロードは不要です（NotebookLM
            欄をご利用ください）。
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-sky-900/85">
            <li>
              「SciSpace を開く」で Chat with PDF を開き、ログインして PDF をアップロードする
            </li>
            <li>必要ならブラウザのアドレスバー URL を下の欄に貼り付け、「リンクを保存」する</li>
            <li>
              論文のタイトル・著者・DOI などは、アップロード時や、この編集エリア内の「SciSpace
              などからコピーしたメタ情報」欄から保存できます
            </li>
          </ol>

          <div className="mt-4 rounded-md border border-sky-200/80 bg-white/70 p-3">
            <p className="text-xs font-medium text-sky-950">SciSpace のページ URL</p>
            <p className="mt-1 text-xs text-sky-900/85">
              よく使うチャットやライブラリの画面など、アドレスバーの URL を登録すると、上の「SciSpace を開く」からそのページを開けます。
            </p>
            {!savedUrl ? (
              <p className="mt-2 text-xs text-sky-800/80">まだ登録されていません。</p>
            ) : null}
            {canEditProjectUrl ? (
              <div className="mt-2 space-y-2">
                <input
                  type="url"
                  inputMode="url"
                  placeholder="https://scispace.com/…"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  className="w-full rounded border border-sky-200 bg-white px-2 py-1.5 text-xs text-zinc-900 placeholder:text-zinc-400"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={urlBusy}
                    onClick={() => void saveProjectUrl()}
                    className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-50"
                  >
                    {urlBusy ? "保存中…" : "リンクを保存"}
                  </button>
                  {savedUrl ? (
                    <button
                      type="button"
                      disabled={urlBusy}
                      onClick={() => void removeProjectUrl()}
                      className="rounded-md border border-sky-300 bg-white px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-50 disabled:opacity-50"
                    >
                      リンクを削除
                    </button>
                  ) : null}
                </div>
                {urlNote ? (
                  <p className="text-xs text-sky-900">{urlNote}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          {documentType === "paper" && canEditProjectUrl && paperMetaInitial ? (
            <SciSpacePaperMetadataPaste testId={testId} initialFields={paperMetaInitial} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
