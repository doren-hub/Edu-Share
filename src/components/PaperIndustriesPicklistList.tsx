"use client";

import { PicklistField } from "@/components/PicklistField";
import { MAX_INDUSTRIES } from "@/lib/paper-industries";

type Props = {
  values: string[];
  onChange: (next: string[]) => void;
};

export function PaperIndustriesPicklistList({ values, onChange }: Props) {
  const rows = values.length > 0 ? values : [""];

  function setRow(i: number, v: string) {
    const next = [...rows];
    next[i] = v;
    onChange(next.filter((_, j) => next[j].trim() !== "" || j < i + 1));
  }

  function addRow() {
    if (rows.length >= MAX_INDUSTRIES) return;
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
        <p className="text-xs font-medium text-violet-950">業界（任意・複数可）</p>
        <button
          type="button"
          disabled={rows.length >= MAX_INDUSTRIES}
          onClick={addRow}
          className="rounded-md border border-violet-300 bg-white px-2 py-1 text-xs font-medium text-violet-900 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          ＋業界を追加
        </button>
      </div>
      {rows.map((v, i) => (
        <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <PicklistField
              category="paper_industry"
              label={`業界 ${i + 1}`}
              id={i === 0 ? "paper-industry" : `paper-industry-${i}`}
              value={v}
              onChange={(nv) => setRow(i, nv)}
              allowOther
              required={false}
            />
          </div>
          {rows.length > 1 ? (
            <button
              type="button"
              onClick={() => removeRow(i)}
              className="shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
            >
              削除
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
