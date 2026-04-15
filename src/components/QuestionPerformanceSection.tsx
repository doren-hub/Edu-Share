import type { QuestionPerformanceRow } from "@/lib/question-performance";

function ratePercent(row: QuestionPerformanceRow): number {
  if (row.attempts <= 0) return 0;
  return Math.round((100 * row.correct_count) / row.attempts);
}

function barColor(rate: number): string {
  if (rate < 50) return "bg-red-500";
  if (rate < 80) return "bg-amber-500";
  return "bg-emerald-500";
}

export function QuestionPerformanceSection({
  rows,
  compact = false,
}: {
  rows: QuestionPerformanceRow[];
  compact?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p className={compact ? "mt-2 text-xs text-zinc-500" : "mt-4 text-sm text-zinc-500"}>
        採点済みのテストが溜まると、設問ごとの正答率が表示されます。
      </p>
    );
  }

  const sorted = [...rows].sort(
    (a, b) => ratePercent(a) - ratePercent(b) || a.attempts - b.attempts,
  );

  const cell = compact ? "px-2 py-2 text-xs" : "px-4 py-3 text-sm";
  const th = compact ? "px-2 py-2 text-[10px]" : "px-4 py-3 text-xs";

  return (
    <div
      className={
        compact ? "mt-2 overflow-x-auto rounded-lg border border-zinc-200" : "mt-4 overflow-x-auto rounded-xl border border-zinc-200"
      }
    >
      <table className={`min-w-full divide-y divide-zinc-200 ${compact ? "text-xs" : "text-sm"}`}>
        <thead className="bg-zinc-50 text-left font-semibold uppercase tracking-wide text-zinc-600">
          <tr>
            <th className={`${th} max-w-[min(12rem,40vw)]`}>設問（抜粋）</th>
            <th className={`${th} whitespace-nowrap`}>形式</th>
            <th className={`${th} whitespace-nowrap`}>正答率</th>
            <th className={`${th} whitespace-nowrap`}>回数</th>
            <th className={`${th} min-w-[72px]`}>傾向</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 bg-white">
          {sorted.map((row) => {
            const rate = ratePercent(row);
            return (
              <tr key={row.question_key}>
                <td className={`${cell} max-w-md text-zinc-900`}>{row.prompt_excerpt}</td>
                <td className={`${cell} whitespace-nowrap text-zinc-700`}>
                  {row.question_type === "multiple_choice" ? "選択" : "記述"}
                </td>
                <td className={`${cell} whitespace-nowrap font-medium tabular-nums text-zinc-900`}>
                  {rate}%
                </td>
                <td className={`${cell} whitespace-nowrap tabular-nums text-zinc-600`}>
                  {row.attempts}
                </td>
                <td className={cell}>
                  <div
                    className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200"
                    title={`正答率 ${rate}%`}
                  >
                    <div
                      className={`h-full rounded-full transition-all ${barColor(rate)}`}
                      style={{ width: `${rate}%` }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p
        className={
          compact
            ? "border-t border-zinc-100 bg-zinc-50 px-2 py-1 text-[10px] text-zinc-500"
            : "border-t border-zinc-100 bg-zinc-50 px-4 py-2 text-xs text-zinc-500"
        }
      >
        記述式は採点 6 点以上を「正解」として集計。行は正答率の低い順です。
      </p>
    </div>
  );
}
