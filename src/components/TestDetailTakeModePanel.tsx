"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { TestStartActionsByMode } from "@/components/TestStartActionsByMode";

type Mode = "standard" | "csv";

export function TestDetailTakeModePanel({
  hasCsvTab,
  testId,
  canPdfStart,
  canNbCsvQuizStart,
  canNbCsvVocabStart,
  mainTakeSearch,
  showRandomPastStandard,
  showReviewMistakesStandard,
  showReviewMistakesCsv,
  reviewMistakeCountStandard,
  reviewMistakeCountCsv,
  initialMode = "standard",
  standardSlot,
  csvSlot,
}: {
  hasCsvTab: boolean;
  testId: string;
  canPdfStart: boolean;
  canNbCsvQuizStart: boolean;
  canNbCsvVocabStart: boolean;
  mainTakeSearch: string;
  showRandomPastStandard: boolean;
  showReviewMistakesStandard: boolean;
  showReviewMistakesCsv: boolean;
  reviewMistakeCountStandard: number;
  reviewMistakeCountCsv: number;
  /** テスト履歴が多い側を初期表示（サーバーで件数比較） */
  initialMode?: Mode;
  standardSlot: ReactNode;
  csvSlot: ReactNode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3">
        {hasCsvTab ? (
          <div
            className="inline-flex w-fit rounded-lg border border-zinc-200 bg-zinc-50/80 p-0.5"
            role="tablist"
            aria-label="出題・履歴の表示モード"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "standard"}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === "standard"
                  ? "bg-white text-zinc-900 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
              onClick={() => setMode("standard")}
            >
              PDF・通常
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "csv"}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === "csv"
                  ? "bg-white text-zinc-900 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
              onClick={() => setMode("csv")}
            >
              NotebookLM CSV
            </button>
          </div>
        ) : null}

        <TestStartActionsByMode
          mode={hasCsvTab ? mode : "standard"}
          testId={testId}
          canPdfStart={canPdfStart}
          canNbCsvQuizStart={canNbCsvQuizStart}
          canNbCsvVocabStart={canNbCsvVocabStart}
          mainTakeSearch={mainTakeSearch}
          showRandomPast={showRandomPastStandard && (!hasCsvTab || mode === "standard")}
          showReviewMistakes={
            !hasCsvTab || mode === "standard"
              ? showReviewMistakesStandard
              : showReviewMistakesCsv
          }
          reviewMistakeCount={
            !hasCsvTab || mode === "standard"
              ? reviewMistakeCountStandard
              : reviewMistakeCountCsv
          }
        />
      </div>

      {hasCsvTab ? (
        <div className="min-w-0">
          {mode === "standard" ? standardSlot : csvSlot}
        </div>
      ) : (
        standardSlot
      )}
    </div>
  );
}
