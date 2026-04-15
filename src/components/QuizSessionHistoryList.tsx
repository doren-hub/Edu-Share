import Link from "next/link";
import { QuizSessionDeleteButton } from "@/components/QuizSessionDeleteButton";

export type QuizSessionHistoryRow = {
  id: string;
  created_at: string;
  score_total: number | null;
  answers_json: unknown;
};

export function QuizSessionHistoryList({
  testId,
  sessions,
}: {
  testId: string;
  sessions: QuizSessionHistoryRow[];
}) {
  if (sessions.length === 0) {
    return (
      <p className="mt-4 text-sm text-zinc-500">まだテスト履歴がありません。</p>
    );
  }
  return (
    <ul className="mt-4 divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-zinc-50/50">
      {sessions.map((s) => {
        const submitted = s.answers_json != null;
        const when = new Date(s.created_at).toLocaleString("ja-JP", {
          dateStyle: "medium",
          timeStyle: "short",
        });
        return (
          <li
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
          >
            <div className="min-w-0">
              <p className="font-medium text-zinc-900">{when}</p>
              <p className="text-xs text-zinc-500">
                {submitted
                  ? `採点済み（総合 ${s.score_total ?? "—"}）`
                  : "未提出（途中まで）"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/tests/${testId}/take?reuse=${s.id}`}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-zinc-50"
              >
                再テスト
              </Link>
              {submitted ? (
                <Link
                  href={`/tests/${testId}/result/${s.id}`}
                  className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-zinc-50"
                >
                  結果を見る
                </Link>
              ) : null}
              <QuizSessionDeleteButton sessionId={s.id} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
