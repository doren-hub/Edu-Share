import { UnderstandingSection } from "@/components/UnderstandingSection";
import type { NotebookLmCsvUnderstandingBundle } from "@/lib/csv-mode-understanding";

export function CsvModeUnderstandingSections({
  bundle,
  performanceLoadError,
}: {
  bundle: NotebookLmCsvUnderstandingBundle;
  performanceLoadError: boolean;
}) {
  return (
    <div className="mt-4">
      {performanceLoadError ? (
        <p className="mb-4 rounded-md border border-amber-200/80 bg-amber-50/90 px-3 py-2 text-xs text-amber-900">
          正答率を読み込めなかったため、理解度の一部が欠けている可能性があります。
        </p>
      ) : null}

      <div>
        <UnderstandingSection
          model={bundle.combined}
          performanceLoadError={false}
          hideScoreCaption
        />
      </div>

      <details className="mt-4 border-t border-zinc-200/80 pt-3">
        <summary className="cursor-pointer list-none text-xs font-medium text-zinc-600 outline-offset-2 marker:content-none hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
          クイズ・単語帳の内訳を表示
        </summary>
        <div className="mt-3 grid gap-6 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
              <span className="text-xs font-medium text-zinc-700">クイズ</span>
              <span className="tabular-nums text-[10px] text-zinc-400">プール {bundle.quizPoolSize} 問</span>
            </div>
            <UnderstandingSection
              model={bundle.quiz}
              performanceLoadError={false}
              compact
              hideScoreCaption
              showProgressBar={false}
            />
          </div>
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
              <span className="text-xs font-medium text-zinc-700">単語帳</span>
              <span className="tabular-nums text-[10px] text-zinc-400">プール {bundle.vocabPoolSize} 問</span>
            </div>
            <UnderstandingSection
              model={bundle.vocab}
              performanceLoadError={false}
              compact
              hideScoreCaption
              showProgressBar={false}
            />
          </div>
        </div>
      </details>
    </div>
  );
}
