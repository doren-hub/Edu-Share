import { createClient } from "@/lib/supabase/server";
import TakeQuiz from "./TakeQuiz";

export default async function TakePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    reuse?: string;
    randomPast?: string;
    review?: string;
    /** 復習モードの対象: csv のとき CSV 由来の誤答のみ */
    csvScope?: string;
    nbCsv?: string;
    vocab?: string;
    csvPool?: string;
  }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const reuseSessionId =
    typeof sp.reuse === "string" && sp.reuse.trim().length > 0
      ? sp.reuse.trim()
      : undefined;
  const pickReviewMistakes =
    !reuseSessionId &&
    typeof sp.review === "string" &&
    (sp.review === "1" || sp.review.toLowerCase() === "true");
  const reviewMistakesScope =
    pickReviewMistakes &&
    typeof sp.csvScope === "string" &&
    sp.csvScope.trim().toLowerCase() === "csv"
      ? ("csv" as const)
      : ("standard" as const);
  const pickRandomPast =
    !reuseSessionId &&
    !pickReviewMistakes &&
    typeof sp.randomPast === "string" &&
    (sp.randomPast === "1" || sp.randomPast.toLowerCase() === "true");
  const csvPoolRaw =
    !reuseSessionId &&
    !pickReviewMistakes &&
    !pickRandomPast &&
    typeof sp.csvPool === "string"
      ? sp.csvPool.trim().toLowerCase()
      : "";
  const notebookLmCsvPool =
    csvPoolRaw === "quiz" || csvPoolRaw === "vocab"
      ? (csvPoolRaw as "quiz" | "vocab")
      : undefined;
  const startWithNotebookLmCsv =
    !reuseSessionId &&
    !pickReviewMistakes &&
    !pickRandomPast &&
    (notebookLmCsvPool !== undefined ||
      (typeof sp.nbCsv === "string" &&
        (sp.nbCsv === "1" || sp.nbCsv.toLowerCase() === "true")));
  const vocabTestHint =
    !reuseSessionId &&
    !pickReviewMistakes &&
    !pickRandomPast &&
    (notebookLmCsvPool === "vocab" ||
      (typeof sp.vocab === "string" &&
        (sp.vocab === "1" || sp.vocab.toLowerCase() === "true")));
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <TakeQuiz
      testId={id}
      initialIsAuthed={!!user}
      reuseSessionId={reuseSessionId}
      pickRandomPast={pickRandomPast}
      pickReviewMistakes={pickReviewMistakes}
      reviewMistakesScope={reviewMistakesScope}
      startWithNotebookLmCsv={startWithNotebookLmCsv}
      notebookLmCsvPool={notebookLmCsvPool}
      vocabTestHint={vocabTestHint}
    />
  );
}
