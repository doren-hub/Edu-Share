"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function UploadPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [ready, setReady] = useState<boolean | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sourceType, setSourceType] = useState<"school" | "expert">("school");
  const [sourceName, setSourceName] = useState("");
  const [documentType, setDocumentType] = useState<"past_exam" | "paper">(
    "past_exam",
  );
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setReady(!!data.user));
  }, [supabase]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("PDFを選択してください");
      return;
    }

    setLoading(true);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("title", title);
    fd.set("description", description);
    fd.set("source_type", sourceType);
    fd.set("source_name", sourceName);
    fd.set("document_type", documentType);

    const res = await fetch("/api/tests/upload", {
      method: "POST",
      body: fd,
      credentials: "include",
    });
    setLoading(false);

    const json = (await res.json().catch(() => null)) as
      | { error?: string; testId?: string }
      | null;

    if (!res.ok) {
      setError(json?.error || "アップロードに失敗しました");
      return;
    }
    if (json?.testId) {
      router.push(`/tests/${json.testId}`);
      router.refresh();
    }
  }

  if (ready === null) {
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <h1 className="text-2xl font-semibold text-zinc-950">PDFアップロード</h1>
        <p className="text-sm text-zinc-600">読み込み中...</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <h1 className="text-2xl font-semibold text-zinc-950">PDFアップロード</h1>
        <p className="text-sm text-zinc-600">
          この機能はログインが必要です。{" "}
          <Link className="underline" href="/auth/login">
            ログイン
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-950">PDFアップロード</h1>
        <p className="mt-2 text-sm text-zinc-600">
          過去問または論文のPDFをアップロードし、出典（学校名 / 専門家名）を紐付けます。取り込み後、共有一覧に表示されます。
        </p>
      </div>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">タイトル</span>
          <input
            className="w-full rounded-md border border-zinc-200 px-3 py-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">説明（任意）</span>
          <textarea
            className="min-h-[90px] w-full rounded-md border border-zinc-200 px-3 py-2"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1 text-sm">
            <span className="text-zinc-700">資料の種類</span>
            <select
              className="w-full rounded-md border border-zinc-200 px-3 py-2"
              value={documentType}
              onChange={(e) =>
                setDocumentType(e.target.value as "past_exam" | "paper")
              }
            >
              <option value="past_exam">過去問</option>
              <option value="paper">論文</option>
            </select>
          </label>

          <label className="block space-y-1 text-sm">
            <span className="text-zinc-700">出典タイプ</span>
            <select
              className="w-full rounded-md border border-zinc-200 px-3 py-2"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as "school" | "expert")}
            >
              <option value="school">学校名</option>
              <option value="expert">専門家名</option>
            </select>
          </label>
        </div>

        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">
            {sourceType === "school" ? "学校名" : "専門家名"}
          </span>
          <input
            className="w-full rounded-md border border-zinc-200 px-3 py-2"
            value={sourceName}
            onChange={(e) => setSourceName(e.target.value)}
            required
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span className="text-zinc-700">PDF</span>
          <input
            type="file"
            accept="application/pdf"
            className="w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </label>

        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {loading ? "アップロード中..." : "アップロードして取り込み"}
        </button>
      </form>
    </div>
  );
}
