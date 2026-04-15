"use client";

import Link from "next/link";
import { useMemo } from "react";

type Mode = "standard" | "csv";

const reviewButtonClass =
  "rounded-md border border-red-200/90 bg-red-50 px-4 py-2 pr-9 text-sm font-medium text-red-900 hover:bg-red-100/80";

function ReviewModeLink({
  href,
  label,
  missCount,
}: {
  href: string;
  label: string;
  missCount: number;
}) {
  const display = missCount > 99 ? "99+" : String(missCount);
  return (
    <Link
      href={href}
      className={`${reviewButtonClass} relative inline-block`}
      aria-label={`${label}（誤答のある設問 ${missCount} 問）`}
    >
      {label}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-red-100 bg-red-600 px-1 text-[10px] font-bold leading-none text-white shadow-sm tabular-nums"
      >
        {display}
      </span>
    </Link>
  );
}

export function TestStartActionsByMode({
  mode,
  testId,
  canPdfStart,
  canNbCsvQuizStart,
  canNbCsvVocabStart,
  mainTakeSearch,
  showRandomPast,
  showReviewMistakes,
  reviewMistakeCount,
}: {
  mode: Mode;
  testId: string;
  canPdfStart: boolean;
  canNbCsvQuizStart: boolean;
  canNbCsvVocabStart: boolean;
  mainTakeSearch: string;
  showRandomPast: boolean;
  showReviewMistakes: boolean;
  /** 復習ボタン右上バッジ用（誤答のある設問数） */
  reviewMistakeCount: number;
}) {
  const showCsvQuiz = canNbCsvQuizStart && canPdfStart;
  const showCsvVocab =
    canNbCsvVocabStart && (canPdfStart || (!canPdfStart && canNbCsvQuizStart));

  const mainLabel = useMemo(
    () =>
      !canPdfStart && canNbCsvVocabStart && !canNbCsvQuizStart
        ? "単語テスト開始"
        : "テスト開始",
    [canPdfStart, canNbCsvQuizStart, canNbCsvVocabStart],
  );

  if (mode === "standard") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/tests/${testId}/take${mainTakeSearch}`}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          {mainLabel}
        </Link>
        {showRandomPast ? (
          <Link
            href={`/tests/${testId}/take?randomPast=1`}
            className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
          >
            過去の問題から出題
          </Link>
        ) : null}
        {showReviewMistakes ? (
          <ReviewModeLink
            href={`/tests/${testId}/take?review=1`}
            label="復習モード"
            missCount={reviewMistakeCount}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {showCsvQuiz ? (
        <Link
          href={`/tests/${testId}/take?csvPool=quiz`}
          className="rounded-md border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-950 hover:bg-violet-100"
        >
          NotebookLM CSVでテスト開始
        </Link>
      ) : null}
      {showCsvVocab ? (
        <Link
          href={`/tests/${testId}/take?csvPool=vocab`}
          className="rounded-md border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-950 hover:bg-violet-100"
        >
          単語テスト開始（CSV）
        </Link>
      ) : null}
      {showReviewMistakes ? (
        <ReviewModeLink
          href={`/tests/${testId}/take?review=1&csvScope=csv`}
          label="復習モード（CSV）"
          missCount={reviewMistakeCount}
        />
      ) : null}
    </div>
  );
}
