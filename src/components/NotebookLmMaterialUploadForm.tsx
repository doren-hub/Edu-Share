"use client";

import {
  looksLikeSlidePdf,
  looksLikeVideoMp4,
} from "@/lib/pdfs-bucket-upload";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) {
    return `HTTP ${res.status}（応答が空です。デプロイ環境のリクエストサイズ制限の可能性があります）`;
  }
  try {
    const j = JSON.parse(text) as { error?: string; details?: string };
    const d = j.details?.trim();
    if (d) return `${j.error ?? "エラー"}\n${d}`;
    return j.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}\n${text.slice(0, 800)}`;
  }
}

async function uploadDirectlyToR2(
  commitUrl: string,
  file: File,
  contentType: "application/pdf" | "video/mp4",
): Promise<void> {
  const prepare = await fetch(commitUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "prepare", size: file.size }),
  });
  if (!prepare.ok) throw new Error(await readApiError(prepare));
  const prepared = (await prepare.json()) as { uploadUrl?: string };
  if (!prepared.uploadUrl) throw new Error("R2アップロードURLを取得できませんでした");

  const upload = await fetch(prepared.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!upload.ok) {
    throw new Error(
      `R2へのアップロードに失敗しました（HTTP ${upload.status}）。R2 バケットの CORS 設定を確認してください。`,
    );
  }

  const commit = await fetch(commitUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "commit" }),
  });
  if (!commit.ok) throw new Error(await readApiError(commit));
}

export function NotebookLmMaterialUploadForm({
  testId,
  hasSlidePdf,
  hasVideoMp4,
}: {
  testId: string;
  hasSlidePdf: boolean;
  hasVideoMp4: boolean;
}) {
  const router = useRouter();
  const slideInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [slideBusy, setSlideBusy] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function uploadSlide(file: File) {
    setError(null);
    setNote(null);
    setSlideBusy(true);
    try {
      if (!looksLikeSlidePdf(file)) {
        setError("スライドは PDF のみアップロードできます");
        return;
      }

      await uploadDirectlyToR2(
        `/api/tests/${testId}/material/slide/commit`,
        file,
        "application/pdf",
      );

      setNote("スライド用 PDF を登録しました。");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "アップロードに失敗しました");
    } finally {
      setSlideBusy(false);
      if (slideInputRef.current) slideInputRef.current.value = "";
    }
  }

  async function uploadVideo(file: File) {
    setError(null);
    setNote(null);
    setVideoBusy(true);
    try {
      if (!looksLikeVideoMp4(file)) {
        setError("動画は MP4 のみアップロードできます");
        return;
      }

      await uploadDirectlyToR2(
        `/api/tests/${testId}/material/video/commit`,
        file,
        "video/mp4",
      );

      setNote("動画 MP4 を登録しました。");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "アップロードに失敗しました");
    } finally {
      setVideoBusy(false);
      if (videoInputRef.current) videoInputRef.current.value = "";
    }
  }

  async function deleteSlide() {
    setError(null);
    setNote(null);
    setSlideBusy(true);
    try {
      const res = await fetch(`/api/tests/${testId}/material/slide`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      setNote("スライド用 PDF を削除しました。");
      router.refresh();
    } finally {
      setSlideBusy(false);
    }
  }

  async function deleteVideo() {
    setError(null);
    setNote(null);
    setVideoBusy(true);
    try {
      const res = await fetch(`/api/tests/${testId}/material/video`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      setNote("動画を削除しました。");
      router.refresh();
    } finally {
      setVideoBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <h4 className="text-sm font-semibold text-zinc-900">スライド・動画（ファイル）</h4>
      <p className="mt-1 text-xs text-zinc-600">
        スライドは <strong>PDF</strong>、動画は <strong>MP4</strong> をアップロードしてください（大きなファイルはブラウザから
        R2 へ直接送ります）。登録後、下の資料枠を横にスライドして表示できます。
      </p>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-zinc-100 bg-zinc-50/80 p-3">
          <p className="text-xs font-medium text-zinc-800">スライド（PDF）</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {hasSlidePdf ? "登録済み" : "未登録"} {slideBusy ? "（処理中…）" : null}
          </p>
          <input
            ref={slideInputRef}
            type="file"
            accept="application/pdf,.pdf"
            disabled={slideBusy}
            className="mt-2 block w-full text-xs text-zinc-700 file:mr-2 file:rounded file:border-0 file:bg-zinc-200 file:px-2 file:py-1"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadSlide(f);
            }}
          />
          {hasSlidePdf ? (
            <button
              type="button"
              disabled={slideBusy}
              onClick={() => void deleteSlide()}
              className="mt-2 text-xs font-medium text-red-700 underline hover:text-red-900 disabled:opacity-50"
            >
              PDF を削除
            </button>
          ) : null}
        </div>

        <div className="rounded-md border border-zinc-100 bg-zinc-50/80 p-3">
          <p className="text-xs font-medium text-zinc-800">動画（MP4）</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {hasVideoMp4 ? "登録済み" : "未登録"} {videoBusy ? "（処理中…）" : null}
          </p>
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,.mp4"
            disabled={videoBusy}
            className="mt-2 block w-full text-xs text-zinc-700 file:mr-2 file:rounded file:border-0 file:bg-zinc-200 file:px-2 file:py-1"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadVideo(f);
            }}
          />
          {hasVideoMp4 ? (
            <button
              type="button"
              disabled={videoBusy}
              onClick={() => void deleteVideo()}
              className="mt-2 text-xs font-medium text-red-700 underline hover:text-red-900 disabled:opacity-50"
            >
              動画を削除
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {note ? <p className="mt-2 text-sm text-emerald-800">{note}</p> : null}
    </div>
  );
}
