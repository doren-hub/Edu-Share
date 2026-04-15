"use client";

import { useEffect, useMemo, useState } from "react";
import { paperAuthorNamesForDisplay } from "@/lib/paper-authors";

type Props = {
  paperAuthors: unknown;
  sourceNameFallback: string;
  /** 著者がこの人数以上のとき、先頭1名＋「+N more」に折りたたむ（既定: 2） */
  collapseMin?: number;
  /**
   * true: 折りたたみ可能なとき最初から全員表示（個別テストページ向け）。
   * false または省略: 省略表示が初期（一覧・教材ハブ向け）。
   */
  defaultExpanded?: boolean;
  /** 一覧のコンパクト行向けの小さめリンク */
  compact?: boolean;
  className?: string;
};

export function PaperAuthorsCollapsible({
  paperAuthors,
  sourceNameFallback,
  collapseMin = 2,
  defaultExpanded = false,
  compact,
  className,
}: Props) {
  const names = useMemo(
    () => paperAuthorNamesForDisplay(paperAuthors, sourceNameFallback),
    [paperAuthors, sourceNameFallback],
  );
  const namesKey = names.join("|");
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [namesKey, defaultExpanded]);

  if (names.length === 0) {
    return <span className={className}>—</span>;
  }

  const fullLine = names.join(", ");
  const useCollapse = names.length >= collapseMin;

  if (!useCollapse) {
    return <span className={className}>{fullLine}</span>;
  }

  const btnClass = compact
    ? "ml-0.5 align-baseline text-[11px] font-medium text-violet-700 underline decoration-violet-400/80 hover:text-violet-900"
    : "ml-0.5 align-baseline text-xs font-medium text-violet-700 underline decoration-violet-400/80 hover:text-violet-900";

  if (expanded) {
    return (
      <span className={`inline break-words ${className ?? ""}`.trim()}>
        <span>{fullLine}</span>
        <button
          type="button"
          className={btnClass}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(false);
          }}
        >
          {" "}
          - Show less
        </button>
      </span>
    );
  }

  const rest = names.length - 1;

  return (
    <span className={`inline min-w-0 ${className ?? ""}`.trim()}>
      <span>{names[0]}</span>
      <button
        type="button"
        className={btnClass}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setExpanded(true);
        }}
      >
        {" "}
        +{rest} more
      </button>
    </span>
  );
}
