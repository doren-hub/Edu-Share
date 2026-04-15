"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function QuizSessionDeleteButton({
  sessionId,
}: {
  sessionId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onDelete() {
    if (
      !window.confirm(
        "このテスト履歴を削除します。取り消せません。よろしいですか？",
      )
    ) {
      return;
    }
    setErr(null);
    setBusy(true);
    const res = await fetch(`/api/quiz/${sessionId}`, {
      method: "DELETE",
      credentials: "include",
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    setBusy(false);
    if (!res.ok) {
      setErr(json?.error || "削除に失敗しました");
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-stretch gap-1">
      {err ? (
        <span className="max-w-[12rem] text-xs text-red-700">{err}</span>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void onDelete()}
        className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-50 disabled:opacity-60"
      >
        {busy ? "削除中…" : "削除"}
      </button>
    </span>
  );
}
