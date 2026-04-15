import type { ThesisChunkCoverageResult } from "@/lib/thesis-coverage";

export function ThesisCoverageSection({
  stats,
  loadError,
}: {
  stats: ThesisChunkCoverageResult | null;
  loadError: string | null;
}) {
  if (loadError) {
    return (
      <p className="mt-4 text-sm text-amber-800">
        網羅率の算出に失敗しました。しばらくしてから再度お試しください。
      </p>
    );
  }

  if (!stats) {
    return null;
  }

  const { totalChunks, coveredChunks, totalQuestions, percent } = stats;

  if (totalChunks === 0) {
    return (
      <p className="mt-4 text-sm text-zinc-500">
        本文チャンクがまだありません。PDF の取り込み状態を確認してください。
      </p>
    );
  }

  const pct = percent ?? 0;
  const hasQuestions = totalQuestions > 0;

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <p className="text-4xl font-semibold tabular-nums text-zinc-950">
            {hasQuestions ? `${pct}%` : "—"}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {hasQuestions
              ? "チャンクのうち、設問文言と重なりが検出された割合"
              : "まだ出題がありません"}
          </p>
        </div>
        <dl className="grid gap-2 text-sm text-zinc-700 sm:grid-cols-2">
          <div>
            <dt className="text-zinc-500">本文チャンク</dt>
            <dd className="font-medium tabular-nums text-zinc-900">
              {coveredChunks} / {totalChunks} 件が設問と照合ヒット
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">比較した設問数</dt>
            <dd className="font-medium tabular-nums text-zinc-900">
              累計 {totalQuestions} 問（全セッション）
            </dd>
          </div>
        </dl>
      </div>

      {hasQuestions ? (
        <div
          className="h-3 w-full max-w-xl overflow-hidden rounded-full bg-zinc-200"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`網羅率 ${pct}%`}
        >
          <div
            className="h-full rounded-full bg-violet-600 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}

      <p className="max-w-2xl text-xs leading-relaxed text-zinc-500">
        PDF 本文を約 900 字単位のチャンクに分割した「全文の分割」と、出題時に内部保存した根拠テキスト（
        <span className="font-medium text-zinc-700">sourceExcerpt</span>
        ／旧データは設問文＋模範解答）を照合します。各チャンクの先頭・四分点・中央・末尾付近の短文が根拠テキストに
        <span className="font-medium text-zinc-700">含まれるか</span>
        でカバーしたチャンク数の割合です。
      </p>
    </div>
  );
}
