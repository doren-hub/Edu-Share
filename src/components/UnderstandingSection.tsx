import type { UnderstandingDisplay } from "@/lib/understanding-score";

function bandStyles(band: NonNullable<UnderstandingDisplay["band"]>): string {
  switch (band) {
    case "high":
      return "bg-emerald-100 text-emerald-900 ring-emerald-200";
    case "mid":
      return "bg-sky-100 text-sky-900 ring-sky-200";
    case "low":
      return "bg-amber-100 text-amber-900 ring-amber-200";
    default:
      return "bg-rose-100 text-rose-900 ring-rose-200";
  }
}

export function UnderstandingSection({
  model,
  performanceLoadError,
  compact = false,
  hideScoreCaption = false,
  showProgressBar = true,
}: {
  model: UnderstandingDisplay;
  performanceLoadError: boolean;
  /** CSV モードの横並び用。余白・文字サイズを詰める */
  compact?: boolean;
  /** true のとき「理解度（目安）」の一行を出さない（見出しと重複する場合用） */
  hideScoreCaption?: boolean;
  showProgressBar?: boolean;
}) {
  const {
    score,
    band,
    headline,
    formulaNote,
    coveragePercent,
    correctRatePercent,
    coverageStatLabel,
    correctStatLabel,
    coverageValueDisplay,
  } = model;

  return (
    <div className={compact ? "mt-2 space-y-2" : "mt-4 space-y-4"}>
      {performanceLoadError ? (
        <p className={compact ? "text-xs text-amber-800" : "text-sm text-amber-800"}>
          正答率を読み込めなかったため、理解度の一部が欠けている可能性があります。
        </p>
      ) : null}

      <div className={`flex flex-wrap items-start ${compact ? "gap-2" : "gap-4"}`}>
        <div className="tabular-nums">
          <p
            className={
              compact
                ? "text-2xl font-semibold text-zinc-950"
                : "text-4xl font-semibold text-zinc-950"
            }
          >
            {score != null ? `${score}` : "—"}
            {score != null ? (
              <span
                className={
                  compact
                    ? "text-sm font-medium text-zinc-500"
                    : "text-lg font-medium text-zinc-500"
                }
              >
                {" "}
                / 100
              </span>
            ) : null}
          </p>
          {hideScoreCaption ? null : (
            <p className={compact ? "mt-0.5 text-xs text-zinc-600" : "mt-1 text-sm text-zinc-600"}>
              理解度（目安）
            </p>
          )}
        </div>
        {band ? (
          <span
            className={`inline-flex items-center rounded-full font-medium ring-1 ring-inset ${
              compact ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"
            } ${bandStyles(band)}`}
          >
            {headline}
          </span>
        ) : (
          <span
            className={`inline-flex items-center rounded-full bg-zinc-100 font-medium text-zinc-700 ring-1 ring-inset ring-zinc-200 ${
              compact ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"
            }`}
          >
            {headline}
          </span>
        )}
      </div>

      {showProgressBar && score != null && band ? (
        <div
          className={
            compact
              ? "h-2 w-full max-w-none overflow-hidden rounded-full bg-zinc-200"
              : "h-3 w-full max-w-xl overflow-hidden rounded-full bg-zinc-200"
          }
          role="progressbar"
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`理解度 ${score}`}
        >
          <div
            className="h-full rounded-full bg-indigo-600 transition-all"
            style={{ width: `${score}%` }}
          />
        </div>
      ) : null}

      <dl
        className={`grid sm:grid-cols-2 ${
          compact ? "gap-2 text-xs" : "max-w-xl gap-3 text-sm"
        }`}
      >
        <div
          className={`rounded-lg border border-zinc-200 bg-zinc-50/80 ${
            compact ? "px-2 py-1.5" : "px-3 py-2"
          }`}
        >
          <dt className={compact ? "text-[10px] text-zinc-500" : "text-xs text-zinc-500"}>
            {coverageStatLabel ?? "網羅率（論文のみ）"}
          </dt>
          <dd className="mt-0.5 font-medium tabular-nums text-zinc-900">
            {coverageValueDisplay != null && coverageValueDisplay !== ""
              ? coverageValueDisplay
              : coveragePercent != null
                ? `${coveragePercent}%`
                : "—"}
          </dd>
        </div>
        <div
          className={`rounded-lg border border-zinc-200 bg-zinc-50/80 ${
            compact ? "px-2 py-1.5" : "px-3 py-2"
          }`}
        >
          <dt className={compact ? "text-[10px] text-zinc-500" : "text-xs text-zinc-500"}>
            {correctStatLabel ?? "設問の正答率（全体）"}
          </dt>
          <dd className="mt-0.5 font-medium tabular-nums text-zinc-900">
            {correctRatePercent != null ? `${correctRatePercent}%` : "—"}
          </dd>
        </div>
      </dl>

      {compact ? null : (
        <p className="max-w-2xl text-xs leading-relaxed text-zinc-500">{formulaNote}</p>
      )}
    </div>
  );
}
