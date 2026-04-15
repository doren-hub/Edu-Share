"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function TestDeleteButton({ testId }: { testId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    if (
      !window.confirm(
        "このページ、PDF、チャンク、受験セッションをすべて削除します。取り消せません。よろしいですか？",
      )
    ) {
      return;
    }
    setError(null);
    setLoading(true);
    const res = await fetch(`/api/tests/${testId}`, {
      method: "DELETE",
      credentials: "include",
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    setLoading(false);
    if (!res.ok) {
      setError(json?.error || "削除に失敗しました");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {error ? (
        <p className="max-w-xs text-right text-sm text-red-700">{error}</p>
      ) : null}
      <button
        type="button"
        disabled={loading}
        onClick={() => void onDelete()}
        className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-60"
      >
        {loading ? "削除中..." : "このページを削除"}
      </button>
    </div>
  );
}
