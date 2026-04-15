import type { AnswerMap, StoredQuestion } from "@/lib/types";
import { essayScoreFromFeedback } from "@/lib/question-performance";
import { isNotebookLmCsvQuizMcQuestion } from "@/lib/quiz-session-mode";

function essayComment(feedback: unknown, questionId: string): string | null {
  if (!feedback || typeof feedback !== "object") return null;
  const essays = (feedback as { essays?: unknown }).essays;
  if (!Array.isArray(essays)) return null;
  for (const row of essays) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    if (o.id === questionId && typeof o.comment === "string") return o.comment;
  }
  return null;
}

function optionLetter(i: number): string {
  return String.fromCharCode(65 + i);
}

function CsvQuizReferenceBlock({
  q,
}: {
  q: Extract<StoredQuestion, { type: "multiple_choice" }>;
}) {
  const rationale = (q.notebookLmCsvRationale ?? q.sourceExcerpt)?.trim() ?? "";
  return (
    <div className="mt-4">
      <p className="text-xs font-medium text-zinc-600">解説</p>
      {rationale ? (
        <blockquote className="mt-2 whitespace-pre-wrap rounded-lg border border-yellow-200/90 bg-yellow-50/95 px-3 py-2.5 text-sm leading-relaxed text-yellow-950">
          {rationale}
        </blockquote>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">（CSV の解説列は保存されていません）</p>
      )}
    </div>
  );
}

export function ResultSessionReview({
  questions,
  answers,
  feedback,
}: {
  questions: StoredQuestion[];
  answers: AnswerMap;
  feedback: unknown;
}) {
  if (questions.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-zinc-950">問題と解答</h2>
        <p className="mt-2 text-sm text-zinc-500">このセッションに問題データがありません。</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-sm font-semibold text-zinc-950">問題と解答</h2>
      <p className="mt-1 text-xs text-zinc-500">
        NotebookLM クイズ CSV では解説（Rationale）を表示します。ヒントは受験画面でのみ表示されます。PDF
        出題では教材根拠抜粋を表示します。
      </p>
      <ol className="mt-6 space-y-8">
        {questions.map((q, idx) => (
          <li
            key={q.id}
            className="rounded-xl border border-zinc-100 bg-zinc-50/50 p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-medium text-zinc-500">問 {idx + 1}</span>
              <span className="rounded-md bg-zinc-200/80 px-2 py-0.5 text-xs text-zinc-700">
                {q.type === "multiple_choice" ? "選択式" : "記述式"}
              </span>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-zinc-900">
              {q.prompt}
            </p>

            {q.type === "multiple_choice" && isNotebookLmCsvQuizMcQuestion(q) ? (
              <CsvQuizReferenceBlock q={q} />
            ) : (
              <div className="mt-4">
                <p className="text-xs font-medium text-zinc-600">出題根拠（元文）</p>
                {(q.sourceOriginalText ?? q.sourceExcerpt)?.trim() ? (
                  <>
                    <blockquote className="mt-2 whitespace-pre-wrap rounded-lg border border-amber-200/80 bg-amber-50/80 px-3 py-2.5 text-sm leading-relaxed text-amber-950">
                      {(q.sourceOriginalText ?? q.sourceExcerpt)!.trim()}
                    </blockquote>
                    {typeof q.sourcePdfPage === "number" ? (
                      <p className="mt-1.5 text-xs text-zinc-500">
                        出題時に記録した根拠のおおよその PDF 位置:{" "}
                        <span className="font-medium">p.{q.sourcePdfPage}</span>
                      </p>
                    ) : null}
                    {q.sourcePdfHighlightMeta?.matchedPhrase ? (
                      <p className="mt-1 text-xs text-zinc-500">
                        マーカー用に PDF から照合したフレーズ先頭:{" "}
                        <span className="font-mono text-[11px] text-zinc-600">
                          {q.sourcePdfHighlightMeta.matchedPhrase.length > 120
                            ? `${q.sourcePdfHighlightMeta.matchedPhrase.slice(0, 120)}…`
                            : q.sourcePdfHighlightMeta.matchedPhrase}
                        </span>
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-2 text-sm text-zinc-500">
                    （出題時の根拠抜粋は保存されていません。旧データの場合は設問文のみです。）
                  </p>
                )}
              </div>
            )}

            {q.type === "multiple_choice" ? (
              <McBlock q={q} answers={answers} />
            ) : (
              <EssayBlock q={q} answers={answers} feedback={feedback} />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function McBlock({ q, answers }: { q: Extract<StoredQuestion, { type: "multiple_choice" }>; answers: AnswerMap }) {
  const picked = answers[q.id];
  const pickedIdx = typeof picked === "number" ? picked : null;
  const ok = pickedIdx === q.correctIndex;

  return (
    <div className="mt-4 space-y-3">
      <p className="text-xs font-medium text-zinc-600">選択肢と解答</p>
      <ul className="space-y-2">
        {q.options.map((opt, i) => {
          const isCorrect = i === q.correctIndex;
          const isPicked = pickedIdx === i;
          return (
            <li
              key={i}
              className={`flex gap-3 rounded-lg border px-3 py-2 text-sm ${
                isCorrect
                  ? "border-emerald-300 bg-emerald-50 text-emerald-950"
                  : isPicked
                    ? "border-red-300 bg-red-50 text-red-950"
                    : "border-zinc-200 bg-white text-zinc-800"
              }`}
            >
              <span className="shrink-0 font-mono text-xs font-semibold opacity-80">
                {optionLetter(i)}.
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{opt}</span>
              {isCorrect ? (
                <span className="shrink-0 text-xs font-medium text-emerald-800">正解</span>
              ) : null}
              {isPicked && !isCorrect ? (
                <span className="shrink-0 text-xs font-medium text-red-800">あなたの解答</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="text-sm">
        <span className="font-medium text-zinc-700">結果: </span>
        {pickedIdx === null ? (
          <span className="text-amber-800">未回答</span>
        ) : ok ? (
          <span className="text-emerald-700">正解</span>
        ) : (
          <span className="text-red-700">
            不正解（正解は {optionLetter(q.correctIndex)}）
          </span>
        )}
      </p>
    </div>
  );
}

function EssayBlock({
  q,
  answers,
  feedback,
}: {
  q: Extract<StoredQuestion, { type: "essay" }>;
  answers: AnswerMap;
  feedback: unknown;
}) {
  const raw = answers[q.id];
  const text = typeof raw === "string" ? raw : "";
  const score = essayScoreFromFeedback(feedback, q.id);
  const comment = essayComment(feedback, q.id);

  return (
    <div className="mt-4 space-y-3">
      <div>
        <p className="text-xs font-medium text-zinc-600">あなたの解答</p>
        <div className="mt-2 whitespace-pre-wrap rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-zinc-900">
          {text.trim() ? text : "（未回答）"}
        </div>
      </div>
      {q.referenceAnswer?.trim() ? (
        <div>
          <p className="text-xs font-medium text-zinc-600">模範解答（採点参考）</p>
          <div className="mt-2 whitespace-pre-wrap rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-zinc-800">
            {q.referenceAnswer.trim()}
          </div>
        </div>
      ) : null}
      <div>
        <p className="text-xs font-medium text-zinc-600">記述の採点</p>
        <p className="mt-2 text-sm text-zinc-800">
          {score !== null ? (
            <>
              点数: <span className="font-semibold">{score}</span> / 10
            </>
          ) : (
            <span className="text-zinc-500">（講評データなし）</span>
          )}
        </p>
        {comment ? (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">{comment}</p>
        ) : null}
      </div>
    </div>
  );
}
