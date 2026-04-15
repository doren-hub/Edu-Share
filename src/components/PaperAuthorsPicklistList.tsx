"use client";

import { PicklistField } from "@/components/PicklistField";
import { MAX_AUTHORS } from "@/lib/paper-authors";

type Props = {
  values: string[];
  onChange: (next: string[]) => void;
};

export function PaperAuthorsPicklistList({ values, onChange }: Props) {
  const rows = values.length > 0 ? values : [""];

  function setRow(i: number, v: string) {
    const next = [...rows];
    next[i] = v;
    onChange(next.filter((_, j) => next[j].trim() !== "" || j < i + 1));
  }

  function addRow() {
    if (rows.length >= MAX_AUTHORS) return;
    onChange([...rows, ""]);
  }

  function removeRow(i: number) {
    if (rows.length <= 1) {
      onChange([""]);
      return;
    }
    onChange(rows.filter((_, j) => j !== i));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-xs font-medium text-violet-950">著者（複数可）</p>
        <button
          type="button"
          disabled={rows.length >= MAX_AUTHORS}
          onClick={addRow}
          className="rounded-md border border-violet-300 bg-white px-2 py-1 text-xs font-medium text-violet-900 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ＋著者を追加
        </button>
      </div>
      {rows.map((v, i) => (
        <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <PicklistField
              category="expert_name"
              label={i === 0 ? "著者 1" : `著者 ${i + 1}`}
              id={`paper-author-${i}`}
              value={v}
              onChange={(nv) => setRow(i, nv)}
              allowOther
            />
          </div>
          {rows.length > 1 ? (
            <button
              type="button"
              onClick={() => removeRow(i)}
              className="shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              削除
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
