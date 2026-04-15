"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export function TestPdfReupload({
  testId,
  className,
}: {
  testId: string;
  /** 未指定時は下余白付き（セクション外配置用） */
  className?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function uploadFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch(`/api/tests/${testId}/pdf`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        details?: string;
      } | null;
      if (!res.ok) {
        const parts = [json?.error, json?.details].filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        );
        setError(parts.join("\n") || "再アップロードに失敗しました");
        return;
      }
      router.refresh();
    } catch {
      setError("再アップロードに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={className ?? "mt-6"}>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void uploadFile(f);
        }}
      />
      <button
        type="button"
        disabled={busy}
        aria-label="PDFを再アップロード"
        onClick={() => inputRef.current?.click()}
        className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-60"
      >
        {busy ? "取り込み中…" : "PDFを再アップロード"}
      </button>
      {error ? (
        <p className="mt-2 max-w-xs whitespace-pre-wrap text-right text-sm text-red-700 sm:max-w-md">
          {error}
        </p>
      ) : null}
    </div>
  );
}
