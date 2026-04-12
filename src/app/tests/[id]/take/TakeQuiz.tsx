"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ClientQuestion } from "@/lib/types";

export default function TakeQuiz({
  testId,
  initialIsAuthed,
}: {
  testId: string;
  initialIsAuthed: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<ClientQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, number | string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!initialIsAuthed) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      setLoading(true);
      setErr(null);
      const res = await fetch(`/api/tests/${testId}/start`, {
        method: "POST",
        credentials: "include",
      });
      const json = (await res.json().catch(() => null)) as
        | { error?: string; sessionId?: string; questions?: ClientQuestion[] }
        | null;
      if (cancelled) return;
      if (!res.ok) {
        setErr(json?.error || "開始に失敗しました");
        setLoading(false);
        return;
      }
      setSessionId(json?.sessionId ?? null);
      setQuestions(Array.isArray(json?.questions) ? json!.questions! : []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [testId, initialIsAuthed]);

  async function submit() {
    if (!sessionId) return;
    setSubmitting(true);
    setErr(null);
    const res = await fetch(`/api/quiz/${sessionId}/submit`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    setSubmitting(false);
    if (!res.ok) {
      setErr(json?.error || "提出に失敗しました");
      return;
    }
    router.push(`/tests/${testId}/result/${sessionId}`);
    router.refresh();
  }

  if (!initialIsAuthed) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold text-zinc-950">受験にはログインが必要です</h1>
        <p className="text-sm text-zinc-600">
          <Link className="underline" href="/auth/login">
            ログイン
          </Link>{" "}
          してからもう一度アクセスしてください。
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-zinc-950">問題を生成しています</h1>
        <p className="text-sm text-zinc-600">
          Claude + RAG により、毎回まちまちの設問セットを作成します（数十秒かかることがあります）。
        </p>
      </div>
    );
  }

  if (err) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-zinc-950">エラー</h1>
        <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          {err}
        </p>
        <Link
          href={`/tests/${testId}`}
          className="inline-flex rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm hover:bg-zinc-50"
        >
          戻る
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950">テスト</h1>
          <p className="mt-1 text-sm text-zinc-600">
            回答後にスコアが表示されます（選択式は自動採点、記述式は Claude が採点）。
          </p>
        </div>
        <Link
          href={`/tests/${testId}`}
          className="text-sm text-zinc-700 underline hover:text-zinc-950"
        >
          詳細へ戻る
        </Link>
      </div>

      <ol className="space-y-8">
        {questions.map((q, idx) => (
          <li
            key={q.id}
            className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-semibold text-zinc-900">
                問{idx + 1}{" "}
                <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
                  {q.type === "multiple_choice" ? "選択式" : "記述式"}
                </span>
              </p>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-800">{q.prompt}</p>

            {q.type === "multiple_choice" ? (
              <div className="mt-4 space-y-2">
                {q.options.map((opt, i) => (
                  <label
                    key={`${q.id}-${i}`}
                    className="flex cursor-pointer items-start gap-3 rounded-md border border-zinc-200 px-3 py-2 hover:bg-zinc-50"
                  >
                    <input
                      type="radio"
                      name={q.id}
                      checked={answers[q.id] === i}
                      onChange={() =>
                        setAnswers((prev) => ({ ...prev, [q.id]: i }))
                      }
                    />
                    <span className="text-sm text-zinc-800">{opt}</span>
                  </label>
                ))}
              </div>
            ) : (
              <textarea
                className="mt-4 min-h-[120px] w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
                value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                onChange={(e) =>
                  setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                }
                placeholder="回答を入力"
              />
            )}
          </li>
        ))}
      </ol>

      {err ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          {err}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={submitting || !sessionId}
          onClick={() => void submit()}
          className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {submitting ? "採点中..." : "提出してスコアを見る"}
        </button>
      </div>
    </div>
  );
}
