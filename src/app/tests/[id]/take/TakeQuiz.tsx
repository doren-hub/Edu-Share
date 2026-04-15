"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ClientQuestion } from "@/lib/types";

export default function TakeQuiz({
  testId,
  initialIsAuthed,
  reuseSessionId,
  pickRandomPast,
  pickReviewMistakes,
  reviewMistakesScope,
  startWithNotebookLmCsv,
  notebookLmCsvPool,
  vocabTestHint,
}: {
  testId: string;
  initialIsAuthed: boolean;
  reuseSessionId?: string;
  pickRandomPast?: boolean;
  pickReviewMistakes?: boolean;
  reviewMistakesScope?: "standard" | "csv";
  startWithNotebookLmCsv?: boolean;
  /** URL ?csvPool=quiz|vocab */
  notebookLmCsvPool?: "quiz" | "vocab";
  /** URL ?vocab=1 または csvPool=vocab（単語テストの見出し用） */
  vocabTestHint?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<ClientQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, number | string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [csvHintRevealed, setCsvHintRevealed] = useState<Record<string, boolean>>({});

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reuseSessionId
            ? { reuseQuestionsFromSessionId: reuseSessionId }
            : pickReviewMistakes
              ? {
                  pickReviewMistakesSession: true,
                  reviewMistakesScope: reviewMistakesScope ?? "standard",
                }
              : pickRandomPast
                ? { pickRandomPastSession: true }
                : notebookLmCsvPool
                  ? { notebookLmCsvPool }
                  : startWithNotebookLmCsv
                    ? { useNotebookLmCsvPool: true }
                    : {},
        ),
      });
      const json = (await res.json().catch(() => null)) as
        | {
            error?: string;
            details?: string;
            sessionId?: string;
            questions?: ClientQuestion[];
          }
        | null;
      if (cancelled) return;
      if (!res.ok) {
        const base = json?.error || "開始に失敗しました";
        const detail = json?.details?.trim();
        setErr(detail ? `${base}\n${detail}` : base);
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
  }, [
    testId,
    initialIsAuthed,
    reuseSessionId,
    pickRandomPast,
    pickReviewMistakes,
    reviewMistakesScope,
    startWithNotebookLmCsv,
    notebookLmCsvPool,
  ]);

  const isVocabSession = useMemo(
    () => notebookLmCsvPool === "vocab" || !!vocabTestHint,
    [notebookLmCsvPool, vocabTestHint],
  );

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
    const json = (await res.json().catch(() => null)) as {
      error?: string;
      details?: string;
    } | null;
    setSubmitting(false);
    if (!res.ok) {
      const base = json?.error || "提出に失敗しました";
      const detail = json?.details?.trim();
      setErr(detail ? `${base}\n${detail}` : base);
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
        <h1 className="text-2xl font-semibold text-zinc-950">
          {reuseSessionId
            ? "再テスト用の問題を準備しています"
            : pickReviewMistakes
              ? "復習モードの問題を準備しています"
              : pickRandomPast
                ? "過去の問題から出題しています"
                : vocabTestHint
                  ? "単語テストの問題を準備しています"
                  : startWithNotebookLmCsv
                    ? "NotebookLM CSV の問題を準備しています"
                    : "問題を生成しています"}
        </h1>
        <p className="text-sm text-zinc-600">
          {reuseSessionId
            ? "過去に生成した設問セットを読み込んでいます。"
            : pickReviewMistakes
              ? reviewMistakesScope === "csv"
                ? "NotebookLM CSV の履歴のうち、誤答した設問だけを集めて出題しています。"
                : "PDF・通常の履歴のうち、誤答した設問だけを集めて出題しています。"
              : pickRandomPast
                ? "テスト履歴の設問から選んで出題しています。"
                : vocabTestHint
                  ? "表面（用語）に対する裏面（解答）の内容を選択肢から選びます。"
                  : startWithNotebookLmCsv
                    ? "取り込んだ CSV の設問プールから出題します。"
                    : "LLM + RAG により、毎回まちまちの設問セットを作成します（数十秒かかることがあります）。"}
        </p>
      </div>
    );
  }

  if (err) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-zinc-950">エラー</h1>
        <p className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
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
          <h1 className="text-2xl font-semibold text-zinc-950">
            {isVocabSession ? "単語テスト（選択式）" : "テスト"}
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            {isVocabSession
              ? "各問は選択式です。正解は取り込んだ単語帳 CSV の裏面（解答）に対応します。"
              : "回答後にスコアが表示されます（選択式は自動採点、記述式は LLM が採点）。"}
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
                  {q.type === "multiple_choice"
                    ? isVocabSession
                      ? "選択式（単語）"
                      : "選択式"
                    : "記述式"}
                </span>
              </p>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-800">{q.prompt}</p>

            {q.type === "multiple_choice" && q.notebookLmCsvHint?.trim() ? (
              <>
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
                <div className="mt-4">
                  {!csvHintRevealed[q.id] ? (
                    <button
                      type="button"
                      onClick={() =>
                        setCsvHintRevealed((prev) => ({ ...prev, [q.id]: true }))
                      }
                      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-950 hover:bg-amber-100/80"
                    >
                      ヒントを表示
                    </button>
                  ) : (
                    <div>
                      <p className="text-xs font-medium text-zinc-600">ヒント</p>
                      <div className="mt-2 whitespace-pre-wrap rounded-lg border border-amber-200/80 bg-amber-50/80 px-3 py-2.5 text-sm leading-relaxed text-amber-950">
                        {q.notebookLmCsvHint.trim()}
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : q.type === "multiple_choice" ? (
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
        <p className="whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
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
