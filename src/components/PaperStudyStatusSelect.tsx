"use client";

import { useState } from "react";
import {
  PAPER_STUDY_STATUSES,
  PAPER_STUDY_STATUS_LABEL,
  parsePaperStudyStatus,
  type PaperStudyStatus,
} from "@/lib/paper-study-status";

const toneClass: Record<PaperStudyStatus, string> = {
  unconfirmed: "border-zinc-200 bg-white text-zinc-800",
  content_confirmed: "border-sky-200 bg-sky-50 text-sky-950",
  learning: "border-amber-200 bg-amber-50 text-amber-950",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-950",
};

const badgeToneClass: Record<PaperStudyStatus, string> = {
  unconfirmed: "bg-zinc-100 text-zinc-700",
  content_confirmed: "bg-sky-100 text-sky-900",
  learning: "bg-amber-100 text-amber-900",
  completed: "bg-blue-100 text-blue-900",
};

export function PaperStudyStatusSelect({
  testId,
  status,
  onStatusChange,
  showCaption = false,
  initialError = null,
  variant = "field",
  compact = false,
}: {
  testId: string;
  status: PaperStudyStatus;
  onStatusChange: (status: PaperStudyStatus) => void;
  showCaption?: boolean;
  initialError?: string | null;
  /** 論文一覧では受験可能バッジと同じpill */
  variant?: "field" | "badge";
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const selectId = `paper-study-status-${testId}`;

  async function change(nextRaw: string) {
    const next = parsePaperStudyStatus(nextRaw);
    if (!next || next === status || pending) return;
    const previous = status;
    onStatusChange(next);
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/papers/${testId}/study-status`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string;
      };
      if (!res.ok) {
        onStatusChange(previous);
        setError(json.error || "学習ステータスを保存できませんでした");
        return;
      }
      const saved = parsePaperStudyStatus(json.status);
      if (saved) onStatusChange(saved);
    } catch {
      onStatusChange(previous);
      setError("学習ステータスを保存できませんでした");
    } finally {
      setPending(false);
    }
  }

  const badge = variant === "badge";

  return (
    <div className={`flex max-w-full flex-col gap-1 ${badge ? "items-end" : "items-start"}`}>
      {showCaption ? (
        <label htmlFor={selectId} className="text-[11px] font-medium text-zinc-500">
          学習ステータス
        </label>
      ) : (
        <label htmlFor={selectId} className="sr-only">
          学習ステータス
        </label>
      )}
      <select
        id={selectId}
        title="学習ステータス"
        className={
          badge
            ? `cursor-pointer appearance-none border-0 text-center font-medium outline-none disabled:cursor-wait disabled:opacity-70 ${
                compact
                  ? "rounded-md px-2 py-0.5 text-[11px]"
                  : "rounded-full px-3 py-1 text-xs"
              } ${badgeToneClass[status]}`
            : `min-h-8 max-w-full rounded-lg border px-2 py-1 text-xs font-medium shadow-sm outline-none transition focus:ring-2 focus:ring-zinc-200 disabled:cursor-wait disabled:opacity-70 ${toneClass[status]}`
        }
        value={status}
        disabled={pending}
        onChange={(e) => void change(e.target.value)}
      >
        {PAPER_STUDY_STATUSES.map((value) => (
          <option key={value} value={value}>
            {PAPER_STUDY_STATUS_LABEL[value]}
          </option>
        ))}
      </select>
      {error ? (
        <p role="alert" className="max-w-56 text-[11px] leading-snug text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PaperStudyStatusField({
  testId,
  initialStatus,
  initialError = null,
}: {
  testId: string;
  initialStatus: PaperStudyStatus;
  initialError?: string | null;
}) {
  const [status, setStatus] = useState(initialStatus);
  return (
    <PaperStudyStatusSelect
      testId={testId}
      status={status}
      onStatusChange={setStatus}
      initialError={initialError}
    />
  );
}
