import Link from "next/link";
import { notFound } from "next/navigation";
import { ResultSessionReview } from "@/components/ResultSessionReview";
import { createClient } from "@/lib/supabase/server";
import { QuizSessionPdfAnnotator } from "@/components/QuizSessionPdfAnnotator";
import { buildPdfMarkItems } from "@/lib/quiz-pdf-marks";
import type {
  AnswerMap,
  SourcePdfHighlightMeta,
  SourcePdfHighlightRect,
  StoredQuestion,
} from "@/lib/types";
import { inferQuizSessionMaterialMode } from "@/lib/quiz-session-mode";

function sessionIsNotebookLmCsvMode(session: {
  questions_json: unknown;
  notebook_lm_csv_pool?: string | null;
}): boolean {
  const p = session.notebook_lm_csv_pool;
  if (p === "quiz" || p === "vocab") return true;
  return inferQuizSessionMaterialMode(session.questions_json) === "csv";
}

function parseHighlightRects(raw: unknown): SourcePdfHighlightRect[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SourcePdfHighlightRect[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const page = o.page;
    const pr = o.pdfRect;
    if (typeof page !== "number" || !Number.isFinite(page) || page < 1) continue;
    if (!Array.isArray(pr) || pr.length !== 4) continue;
    if (!pr.every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    out.push({
      page: Math.floor(page),
      pdfRect: pr as [number, number, number, number],
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseHighlightMeta(raw: unknown): SourcePdfHighlightMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  if (m.version !== 1) return undefined;
  if (typeof m.resolvedAt !== "string") return undefined;
  return {
    version: 1,
    resolvedAt: m.resolvedAt,
    matchedPhrase: typeof m.matchedPhrase === "string" ? m.matchedPhrase : undefined,
  };
}

function parseStoredQuestions(raw: unknown): StoredQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.prompt !== "string" || typeof o.type !== "string")
      continue;
    if (o.type === "multiple_choice") {
      if (!Array.isArray(o.options) || typeof o.correctIndex !== "number") continue;
      const options = o.options.filter((x): x is string => typeof x === "string");
      if (options.length === 0) continue;
      const sp = o.sourcePdfPage;
      const sourcePdfPage =
        typeof sp === "number" && Number.isFinite(sp) && sp >= 1 ? Math.floor(sp) : undefined;
      const nbRat = (o as { notebookLmCsvRationale?: unknown }).notebookLmCsvRationale;
      const nbHint = (o as { notebookLmCsvHint?: unknown }).notebookLmCsvHint;
      out.push({
        id: o.id,
        type: "multiple_choice",
        prompt: o.prompt,
        options,
        correctIndex: o.correctIndex,
        notebookLmCsvRationale:
          typeof nbRat === "string" && nbRat.trim() ? nbRat.trim() : undefined,
        notebookLmCsvHint:
          typeof nbHint === "string" && nbHint.trim() ? nbHint.trim() : undefined,
        sourceExcerpt: typeof o.sourceExcerpt === "string" ? o.sourceExcerpt : undefined,
        sourceOriginalText:
          typeof o.sourceOriginalText === "string" ? o.sourceOriginalText : undefined,
        sourcePdfPage,
        sourcePdfHighlightRects: parseHighlightRects(o.sourcePdfHighlightRects),
        sourcePdfHighlightMeta: parseHighlightMeta(o.sourcePdfHighlightMeta),
      });
    } else if (o.type === "essay") {
      const sp = o.sourcePdfPage;
      const sourcePdfPage =
        typeof sp === "number" && Number.isFinite(sp) && sp >= 1 ? Math.floor(sp) : undefined;
      out.push({
        id: o.id,
        type: "essay",
        prompt: o.prompt,
        referenceAnswer: typeof o.referenceAnswer === "string" ? o.referenceAnswer : undefined,
        sourceExcerpt: typeof o.sourceExcerpt === "string" ? o.sourceExcerpt : undefined,
        sourceOriginalText:
          typeof o.sourceOriginalText === "string" ? o.sourceOriginalText : undefined,
        sourcePdfPage,
        sourcePdfHighlightRects: parseHighlightRects(o.sourcePdfHighlightRects),
        sourcePdfHighlightMeta: parseHighlightMeta(o.sourcePdfHighlightMeta),
      });
    }
  }
  return out;
}

function parseAnswersJson(raw: unknown): AnswerMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AnswerMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

export default async function ResultPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id: testId, sessionId } = await params;
  const supabase = await createClient();

  const { data: session } = await supabase
    .from("quiz_sessions")
    .select(
      "id,score_total,score_mc,score_essay,feedback_json,created_at,test_id,questions_json,answers_json,notebook_lm_csv_pool",
    )
    .eq("id", sessionId)
    .single();

  if (!session) notFound();
  if (session.test_id !== testId) notFound();

  const { data: testRow } = await supabase
    .from("tests")
    .select("title")
    .eq("id", session.test_id)
    .single();

  const title = testRow?.title ?? "テスト";

  const showMaterialPdfSection = !sessionIsNotebookLmCsvMode(session);

  const pdfMarkItems = showMaterialPdfSection
    ? buildPdfMarkItems({
        questions: session.questions_json,
        answers: session.answers_json,
        feedback: session.feedback_json,
      })
    : [];

  const reviewQuestions = parseStoredQuestions(session.questions_json);
  const reviewAnswers = parseAnswersJson(session.answers_json);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">
          採点結果
        </h1>
        <p className="mt-2 text-sm text-zinc-600">{title}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <p className="text-xs text-zinc-500">総合</p>
          <p className="mt-2 text-3xl font-semibold text-zinc-950">
            {session.score_total ?? "-"}
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <p className="text-xs text-zinc-500">選択式（100点換算）</p>
          <p className="mt-2 text-3xl font-semibold text-zinc-950">
            {session.score_mc ?? "-"}
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <p className="text-xs text-zinc-500">記述式（100点換算）</p>
          <p className="mt-2 text-3xl font-semibold text-zinc-950">
            {session.score_essay ?? "-"}
          </p>
        </div>
      </div>

      <ResultSessionReview
        questions={reviewQuestions}
        answers={reviewAnswers}
        feedback={session.feedback_json}
      />

      {showMaterialPdfSection ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-zinc-950">教材 PDF と正誤マーカー</h2>
          <p className="mt-1 text-xs text-zinc-500">
            出題時に保存した根拠（sourceExcerpt）とページ（sourcePdfPage）がある場合は、そのページ内だけを照合してマーカーを付けます。
            ページ情報がない旧データは設問文で全文から照合します。最大 60 ページまで表示します。
          </p>
          <div className="mt-4">
            <QuizSessionPdfAnnotator testId={testId} markItems={pdfMarkItems} />
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-zinc-950">講評（JSON）</h2>
        <pre className="mt-4 max-h-[420px] overflow-auto rounded-md bg-zinc-950 p-4 text-xs text-zinc-50">
          {JSON.stringify(session.feedback_json ?? {}, null, 2)}
        </pre>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href={`/tests/${testId}`}
          className="rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm hover:bg-zinc-50"
        >
          テスト詳細へ
        </Link>
        <Link
          href={`/tests/${testId}/take?reuse=${sessionId}`}
          className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
        >
          再テスト
        </Link>
      </div>
    </div>
  );
}
