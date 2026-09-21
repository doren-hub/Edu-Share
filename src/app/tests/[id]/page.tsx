import Link from "next/link";
import { notFound } from "next/navigation";
import { TestDeleteButton } from "@/components/TestDeleteButton";
import { TestMetadataEditor } from "@/components/TestMetadataEditor";
import { QuestionPerformanceSection } from "@/components/QuestionPerformanceSection";
import { ThesisCoverageSection } from "@/components/ThesisCoverageSection";
import { UnderstandingSection } from "@/components/UnderstandingSection";
import { QuizSessionDeleteButton } from "@/components/QuizSessionDeleteButton";
import { TestPdfReupload } from "@/components/TestPdfReupload";
import { NotebookLmSection } from "@/components/NotebookLmSection";
import { SciSpaceSection } from "@/components/SciSpaceSection";
import { NotebookLmMaterialUploadForm } from "@/components/NotebookLmMaterialUploadForm";
import { NotebookLmCsvUploadForm } from "@/components/NotebookLmCsvUploadForm";
import { QuizSessionHistoryList } from "@/components/QuizSessionHistoryList";
import { CsvModeUnderstandingSections } from "@/components/CsvModeUnderstandingSections";
import { TestDetailTakeModePanel } from "@/components/TestDetailTakeModePanel";
import { TestStartActionsByMode } from "@/components/TestStartActionsByMode";
import {
  TestMaterialCarousel,
  type MaterialCarouselPane,
} from "@/components/TestMaterialCarousel";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { reconcileExistingPaperMaterialFiles } from "@/lib/reconcile-paper-material-files";
import { canStartNewAutoQuiz, countDocumentChunksForTest } from "@/lib/document-chunks";
import type { QuestionPerformanceRow } from "@/lib/question-performance";
import {
  loadThesisCoverageForUser,
  type ThesisChunkCoverageResult,
} from "@/lib/thesis-coverage";
import {
  aggregateCorrectRatePercent,
  computeUnderstandingDisplay,
} from "@/lib/understanding-score";
import type { DocumentType } from "@/lib/types";
import {
  canStartNotebookLmQuizCsvPool,
  canStartNotebookLmVocabCsvPool,
} from "@/lib/notebooklm-csv";
import {
  computeNotebookLmCsvUnderstandingBundle,
  partitionNotebookLmCsvSessionsByPool,
  splitNotebookLmCsvPerformanceRows,
} from "@/lib/csv-mode-understanding";
import {
  buildCsvQuestionPerformanceKeySet,
  filterQuestionPerformanceForCsvMode,
  filterQuestionPerformanceForStandardMode,
  inferQuizSessionMaterialMode,
  partitionSessionsByMaterialMode,
} from "@/lib/quiz-session-mode";
import {
  countMissedQuestionsInPerformanceRows,
  hasMissesInPerformanceRows,
} from "@/lib/review-mode";
import { PaperAuthorsCollapsible } from "@/components/PaperAuthorsCollapsible";
import { normalizePaperAuthorsFromDb } from "@/lib/paper-authors";
import { normalizePaperDoiDisplay, paperDoiHref } from "@/lib/paper-doi";

/** マイグレーション未適用時は資料用列が無く select が失敗する → 列なしで再取得する */
const TEST_DETAIL_BASE_SELECT =
  "id,title,description,source_name,processing_status,processing_error,created_at,document_type,exam_department,exam_subject,exam_period,industry,publication_year,paper_doi,paper_venue,paper_authors,uploaded_by,quiz_source,notebooklm_questions_json,notebooklm_vocab_questions_json";

const TEST_DETAIL_MATERIAL_COLS =
  "notebooklm_slide_pdf_storage_path,notebooklm_video_mp4_storage_path,notebooklm_notebook_url,scispace_project_url,pdf_filename";

async function loadTestDetailRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
) {
  const full = `${TEST_DETAIL_BASE_SELECT},${TEST_DETAIL_MATERIAL_COLS}`;
  const first = await supabase.from("tests").select(full).eq("id", id).single();
  if (first.data) return first.data;

  const msg = (first.error?.message ?? "").toLowerCase();
  const looksLikeMissingMaterialColumn =
    msg.includes("notebooklm_slide_pdf_storage_path") ||
    msg.includes("notebooklm_video_mp4_storage_path") ||
    msg.includes("notebooklm_notebook_url") ||
    msg.includes("scispace_project_url") ||
    msg.includes("pdf_filename") ||
    msg.includes("quiz_source") ||
    msg.includes("notebooklm_questions_json") ||
    msg.includes("notebooklm_vocab_questions_json") ||
    msg.includes("paper_authors") ||
    msg.includes("paper_doi") ||
    msg.includes("paper_venue") ||
    msg.includes("schema cache") ||
    (msg.includes("column") && msg.includes("does not exist"));

  if (first.error && looksLikeMissingMaterialColumn) {
    const second = await supabase
      .from("tests")
      .select(TEST_DETAIL_BASE_SELECT)
      .eq("id", id)
      .single();
    if (second.data) {
      return {
        ...second.data,
        notebooklm_slide_pdf_storage_path:
          (second.data as { notebooklm_slide_pdf_storage_path?: string | null })
            .notebooklm_slide_pdf_storage_path ?? null,
        notebooklm_video_mp4_storage_path:
          (second.data as { notebooklm_video_mp4_storage_path?: string | null })
            .notebooklm_video_mp4_storage_path ?? null,
        notebooklm_notebook_url:
          (second.data as { notebooklm_notebook_url?: string | null }).notebooklm_notebook_url ??
          null,
        scispace_project_url:
          (second.data as { scispace_project_url?: string | null }).scispace_project_url ?? null,
        pdf_filename:
          (second.data as { pdf_filename?: string | null }).pdf_filename ?? null,
      };
    }
  }
  return null;
}

const MATERIAL_SIGN_TTL_SEC = 3600;

async function signMaterialUrls(
  slidePath: string | null | undefined,
  videoPath: string | null | undefined,
): Promise<{ slideSigned: string | null; videoSigned: string | null }> {
  const sp = slidePath?.trim();
  const vp = videoPath?.trim();
  if (!sp && !vp) return { slideSigned: null, videoSigned: null };
  try {
    const admin = createAdminClient();
    let slideSigned: string | null = null;
    let videoSigned: string | null = null;
    if (sp) {
      const { data } = await admin.storage
        .from("pdfs")
        .createSignedUrl(sp, MATERIAL_SIGN_TTL_SEC);
      slideSigned = data?.signedUrl ?? null;
    }
    if (vp) {
      const { data } = await admin.storage
        .from("pdfs")
        .createSignedUrl(vp, MATERIAL_SIGN_TTL_SEC);
      videoSigned = data?.signedUrl ?? null;
    }
    return { slideSigned, videoSigned };
  } catch {
    return { slideSigned: null, videoSigned: null };
  }
}

export default async function TestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const test = await loadTestDetailRow(supabase, id);

  if (!test) notFound();

  const isPaper = (test.document_type ?? "past_exam") === "paper";

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const chunkCount =
    test.processing_status === "ready"
      ? await countDocumentChunksForTest(test.id)
      : 0;
  const canPdfStart = canStartNewAutoQuiz({
    chunkCount,
    processingError: test.processing_error,
  });
  const canNbCsvQuizStart = canStartNotebookLmQuizCsvPool(
    test as { notebooklm_questions_json?: unknown },
  );
  const canNbCsvVocabStart = canStartNotebookLmVocabCsvPool(
    test as {
      notebooklm_vocab_questions_json?: unknown;
      notebooklm_questions_json?: unknown;
    },
  );
  const notebookLmCsvQuizQuestionCount = Array.isArray(test.notebooklm_questions_json)
    ? test.notebooklm_questions_json.length
    : 0;
  const notebookLmCsvVocabQuestionCount = Array.isArray(test.notebooklm_vocab_questions_json)
    ? test.notebooklm_vocab_questions_json.length
    : 0;
  const canNbCsvStart = canNbCsvQuizStart || canNbCsvVocabStart;
  const canMainStart = canPdfStart || canNbCsvStart;
  const showCsvQuizForTab = canNbCsvQuizStart && canPdfStart;
  const showCsvVocabForTab =
    canNbCsvVocabStart && (canPdfStart || (!canPdfStart && canNbCsvQuizStart));
  const hasCsvTab = showCsvQuizForTab || showCsvVocabForTab;
  const mainTakeSearch = !canPdfStart
    ? canNbCsvQuizStart
      ? "?csvPool=quiz"
      : canNbCsvVocabStart
        ? "?csvPool=vocab"
        : ""
    : "";

  let mySessions: Array<{
    id: string;
    created_at: string;
    score_total: number | null;
    answers_json: unknown;
    questions_json: unknown;
    notebook_lm_csv_pool?: string | null;
  }> = [];
  if (user && test.processing_status === "ready") {
    const { data: sessRows } = await supabase
      .from("quiz_sessions")
      .select(
        "id, created_at, score_total, answers_json, questions_json, notebook_lm_csv_pool",
      )
      .eq("test_id", test.id)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30);
    mySessions = sessRows ?? [];
  }

  let performanceRows: QuestionPerformanceRow[] = [];
  let performanceLoadError: string | null = null;
  if (user && test.processing_status === "ready") {
    const { data: perfData, error: perfErr } = await supabase
      .from("question_performance")
      .select(
        "question_key, prompt_excerpt, question_type, attempts, correct_count, updated_at",
      )
      .eq("test_id", test.id)
      .eq("user_id", user.id);
    if (perfErr) {
      performanceLoadError = perfErr.message;
      console.error(
        "[test detail] question_performance select failed",
        perfErr.code,
        perfErr.message,
      );
    } else if (Array.isArray(perfData)) {
      performanceRows = perfData as QuestionPerformanceRow[];
    }
  }

  let thesisCoverageStats: ThesisChunkCoverageResult | null = null;
  let thesisCoverageError: string | null = null;
  if (user && test.processing_status === "ready" && isPaper) {
    const cov = await loadThesisCoverageForUser({
      testId: test.id,
      userId: user.id,
    });
    if (cov.ok) {
      thesisCoverageStats = cov.stats;
    } else {
      thesisCoverageError = cov.error;
      console.error("[test detail] thesis coverage failed", cov.error);
    }
  }

  const csvQuestionPerfKeys =
    user && test.processing_status === "ready"
      ? buildCsvQuestionPerformanceKeySet(test.id, mySessions)
      : new Set<string>();
  const performanceRowsStandard = filterQuestionPerformanceForStandardMode(
    performanceRows,
    csvQuestionPerfKeys,
  );
  const performanceRowsCsv = filterQuestionPerformanceForCsvMode(
    performanceRows,
    csvQuestionPerfKeys,
  );
  const { standard: mySessionsStandard, csv: mySessionsCsv } =
    user && test.processing_status === "ready"
      ? partitionSessionsByMaterialMode(mySessions)
      : { standard: [] as typeof mySessions, csv: [] as typeof mySessions };

  const understandingModelMerged =
    user && test.processing_status === "ready"
      ? computeUnderstandingDisplay({
          isPaper,
          coveragePercent: isPaper
            ? (thesisCoverageStats?.percent ?? null)
            : null,
          correctRatePercent: performanceLoadError
            ? null
            : aggregateCorrectRatePercent(performanceRows),
        })
      : null;

  const understandingStandardModel =
    user && test.processing_status === "ready"
      ? computeUnderstandingDisplay({
          isPaper,
          coveragePercent: isPaper
            ? (thesisCoverageStats?.percent ?? null)
            : null,
          correctRatePercent: performanceLoadError
            ? null
            : aggregateCorrectRatePercent(performanceRowsStandard),
        })
      : null;

  const csvUnderstandingBundle =
    user && test.processing_status === "ready" && hasCsvTab
      ? computeNotebookLmCsvUnderstandingBundle({
          testRow: test as {
            notebooklm_questions_json?: unknown;
            notebooklm_vocab_questions_json?: unknown;
          },
          testId: test.id,
          performanceRowsCsv,
          mySessionsCsv,
        })
      : null;

  const csvSessionsByPool =
    user && test.processing_status === "ready" && hasCsvTab
      ? partitionNotebookLmCsvSessionsByPool(mySessionsCsv)
      : {
          quiz: [] as typeof mySessionsCsv,
          vocab: [] as typeof mySessionsCsv,
          unknown: [] as typeof mySessionsCsv,
        };

  const csvPerfByPool =
    user && test.processing_status === "ready" && hasCsvTab
      ? splitNotebookLmCsvPerformanceRows(test.id, mySessionsCsv, performanceRowsCsv)
      : { quiz: [] as QuestionPerformanceRow[], vocab: [] as QuestionPerformanceRow[] };

  /** 直近の受験（採点済みを優先）の出題種別で初期タブを決める */
  const lastSessionForTabMode =
    mySessions.find((s) => s.answers_json != null) ?? mySessions[0] ?? null;
  const takeModeInitial: "standard" | "csv" =
    hasCsvTab && lastSessionForTabMode
      ? inferQuizSessionMaterialMode(lastSessionForTabMode.questions_json) === "csv"
        ? "csv"
        : "standard"
      : "standard";

  const showReviewMistakesStandard =
    Boolean(user) &&
    test.processing_status === "ready" &&
    hasMissesInPerformanceRows(performanceRowsStandard) &&
    mySessionsStandard.length > 0;

  const showReviewMistakesCsv =
    Boolean(user) &&
    test.processing_status === "ready" &&
    hasCsvTab &&
    hasMissesInPerformanceRows(performanceRowsCsv) &&
    mySessionsCsv.length > 0;

  const reviewMistakeCountStandard = countMissedQuestionsInPerformanceRows(
    performanceRowsStandard,
  );
  const reviewMistakeCountCsv = countMissedQuestionsInPerformanceRows(
    performanceRowsCsv,
  );

  const slidePathRaw =
    (test as { notebooklm_slide_pdf_storage_path?: string | null }).notebooklm_slide_pdf_storage_path?.trim() ??
    "";
  const videoPathRaw =
    (test as { notebooklm_video_mp4_storage_path?: string | null }).notebooklm_video_mp4_storage_path?.trim() ??
    "";
  const [materialFiles] = await reconcileExistingPaperMaterialFiles([
    {
      id: test.id,
      notebooklm_slide_pdf_storage_path: slidePathRaw || null,
      notebooklm_video_mp4_storage_path: videoPathRaw || null,
    },
  ]);
  const slidePath = materialFiles?.notebooklm_slide_pdf_storage_path?.trim() ?? "";
  const videoPath = materialFiles?.notebooklm_video_mp4_storage_path?.trim() ?? "";
  const notebookLmNotebookUrl =
    (test as { notebooklm_notebook_url?: string | null }).notebooklm_notebook_url?.trim() ?? "";
  const scispaceProjectUrl =
    (test as { scispace_project_url?: string | null }).scispace_project_url?.trim() ?? "";

  const { slideSigned, videoSigned } = await signMaterialUrls(slidePath, videoPath);

  const materialPanes: MaterialCarouselPane[] = [
    { key: "pdf", label: "元PDF", pdfSrc: `/api/tests/${test.id}/pdf` },
  ];
  if (slidePath && slideSigned) {
    materialPanes.push({
      key: "slide",
      label: "スライド（PDF）",
      slideSrc: slideSigned,
    });
  }
  if (videoPath && videoSigned) {
    materialPanes.push({
      key: "video",
      label: "動画（MP4）",
      videoSrc: videoSigned,
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">
              {test.title}
            </h1>
            {test.description ? (
              <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600">
                {test.description}
              </p>
            ) : null}
          </div>
          <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-700">
            {test.processing_status}
          </span>
        </div>

        <dl className="mt-6 grid gap-3 text-sm text-zinc-700 sm:grid-cols-2">
          <div>
            <dt className="text-zinc-500">資料</dt>
            <dd className="font-medium text-zinc-900">
              {(test.document_type ?? "past_exam") === "paper" ? "論文" : "過去問（学校）"}
            </dd>
          </div>
          {(test.document_type ?? "past_exam") === "paper" ? (
            <>
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">著者</dt>
                <dd className="font-medium text-zinc-900">
                  <PaperAuthorsCollapsible
                    paperAuthors={
                      (test as { paper_authors?: unknown }).paper_authors
                    }
                    sourceNameFallback={test.source_name}
                    defaultExpanded
                  />
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">掲載</dt>
                <dd className="font-medium text-zinc-900">
                  {(test as { paper_venue?: string | null }).paper_venue?.trim() ||
                    "—"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">DOI</dt>
                <dd>
                  {(() => {
                    const doi = normalizePaperDoiDisplay(
                      (test as { paper_doi?: string | null }).paper_doi,
                    );
                    if (!doi) return "—";
                    const href = paperDoiHref(doi);
                    return (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-violet-700 underline decoration-violet-400/80 hover:text-violet-900"
                      >
                        {doi}
                      </a>
                    );
                  })()}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">PDFファイル名</dt>
                <dd className="font-mono text-sm font-medium text-zinc-900">
                  {(test as { pdf_filename?: string | null }).pdf_filename?.trim() || "—"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">業界</dt>
                <dd className="font-medium text-zinc-900">
                  {test.industry ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">発表年</dt>
                <dd className="font-medium text-zinc-900">
                  {test.publication_year
                    ? `${test.publication_year}年`
                    : "—"}
                </dd>
              </div>
            </>
          ) : (
            <>
              <div>
                <dt className="text-zinc-500">学校名</dt>
                <dd className="font-medium text-zinc-900">{test.source_name}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">学科名</dt>
                <dd className="font-medium text-zinc-900">
                  {test.exam_department ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">科目</dt>
                <dd className="font-medium text-zinc-900">
                  {test.exam_subject ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">テストの時期</dt>
                <dd className="font-medium text-zinc-900">
                  {test.exam_period ?? "—"}
                </dd>
              </div>
            </>
          )}
        </dl>

        {test.processing_status === "failed" && test.processing_error ? (
          <p className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            取り込み失敗: {test.processing_error}
          </p>
        ) : null}

        {test.processing_status === "ready" && test.processing_error ? (
          <p className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            {test.processing_error}
          </p>
        ) : null}

        {user?.id && test.uploaded_by === user.id ? (
          <TestMetadataEditor
            initial={{
              id: test.id,
              title: test.title,
              description: test.description,
              source_name: test.source_name,
              document_type: (test.document_type ?? "past_exam") as DocumentType,
              exam_department: test.exam_department ?? null,
              exam_subject: test.exam_subject ?? null,
              exam_period: test.exam_period ?? null,
              industry: test.industry ?? null,
              publication_year: test.publication_year ?? null,
              paper_authors: (test as { paper_authors?: unknown }).paper_authors,
              paper_venue: (test as { paper_venue?: string | null }).paper_venue,
              paper_doi: (test as { paper_doi?: string | null }).paper_doi,
            }}
          />
        ) : null}

        {user?.id &&
        test.uploaded_by === user.id &&
        (test.processing_status === "failed" ||
          test.processing_status === "pending") ? (
          <TestPdfReupload testId={test.id} />
        ) : null}

        {test.processing_status === "ready" ? (
          <section className="mt-10 border-t border-zinc-100 pt-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-zinc-950">資料</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  元の PDF に加え、登録したスライド用 PDF・動画 MP4 がある場合は、枠内を横にスライドして切り替えられます。
                </p>
              </div>
              {user?.id && test.uploaded_by === user.id ? (
                <div className="shrink-0">
                  <TestPdfReupload testId={test.id} className="mt-0 flex flex-col items-end" />
                </div>
              ) : null}
            </div>
            {user ? (
              <div className="mt-4 space-y-3">
                <NotebookLmSection
                  testId={test.id}
                  enabled
                  initialNotebookUrl={notebookLmNotebookUrl || null}
                  canEditNotebookUrl={user.id === test.uploaded_by}
                  materialUpload={
                    user.id === test.uploaded_by ? (
                      <NotebookLmMaterialUploadForm
                        testId={test.id}
                        hasSlidePdf={Boolean(slidePath)}
                        hasVideoMp4={Boolean(videoPath)}
                      />
                    ) : null
                  }
                  csvUpload={
                    user.id === test.uploaded_by ? (
                      <NotebookLmCsvUploadForm
                        existingTestId={test.id}
                        defaultTitle={test.title}
                        defaultDescription={test.description ?? null}
                        notebookLmQuizQuestionCount={notebookLmCsvQuizQuestionCount}
                        notebookLmVocabQuestionCount={notebookLmCsvVocabQuestionCount}
                      />
                    ) : null
                  }
                />
                <SciSpaceSection
                  testId={test.id}
                  initialProjectUrl={scispaceProjectUrl || null}
                  canEditProjectUrl={user.id === test.uploaded_by}
                  documentType={isPaper ? "paper" : "past_exam"}
                  paperMetaInitial={
                    isPaper && user.id === test.uploaded_by
                      ? {
                          title: test.title,
                          paperAuthors: normalizePaperAuthorsFromDb(
                            (test as { paper_authors?: unknown }).paper_authors,
                          ),
                          paperVenue:
                            (test as { paper_venue?: string | null }).paper_venue?.trim() ??
                            "",
                          paperDoi:
                            (test as { paper_doi?: string | null }).paper_doi?.trim() ?? "",
                          industry:
                            (test as { industry?: string | null }).industry?.trim() ?? "",
                          publicationYear: (() => {
                            const y = String(
                              (test as { publication_year?: string | null })
                                .publication_year ?? "",
                            ).trim();
                            return y && /^\d{4}$/.test(y) ? y : "";
                          })(),
                        }
                      : null
                  }
                />
                <TestMaterialCarousel title={test.title} panes={materialPanes} />
              </div>
            ) : (
              <p className="mt-4 text-sm text-zinc-600">
                PDFを表示するには{" "}
                <Link className="font-medium underline" href="/auth/login">
                  ログイン
                </Link>{" "}
                してください。
              </p>
            )}
          </section>
        ) : null}

        {test.processing_status === "ready" ? (
          user ? (
            canMainStart && hasCsvTab ? (
              <div className="mt-8">
                <TestDetailTakeModePanel
                  hasCsvTab
                  testId={test.id}
                  canPdfStart={canPdfStart}
                  canNbCsvQuizStart={canNbCsvQuizStart}
                  canNbCsvVocabStart={canNbCsvVocabStart}
                  mainTakeSearch={mainTakeSearch}
                  showRandomPastStandard={mySessionsStandard.length > 0}
                  showReviewMistakesStandard={showReviewMistakesStandard}
                  showReviewMistakesCsv={showReviewMistakesCsv}
                  reviewMistakeCountStandard={reviewMistakeCountStandard}
                  reviewMistakeCountCsv={reviewMistakeCountCsv}
                  initialMode={takeModeInitial}
                  standardSlot={
                    <>
                      {understandingStandardModel ? (
                        <section className="border-t border-zinc-100 pt-8">
                          <h2 className="text-lg font-semibold text-zinc-950">理解度</h2>
                          <p className="mt-1 text-sm text-zinc-600">
                            論文では網羅率と設問の正答率の積（÷100）を理解度の目安にしています。過去問などは正答率のみです。
                          </p>
                          <UnderstandingSection
                            model={understandingStandardModel}
                            performanceLoadError={!!performanceLoadError}
                          />
                        </section>
                      ) : null}
                      {isPaper ? (
                        <section className="mt-10 border-t border-zinc-100 pt-8">
                          <h2 className="text-lg font-semibold text-zinc-950">論文の網羅率</h2>
                          <p className="mt-1 text-sm text-zinc-600">
                            PDF 本文のチャンクと、出題時に保存した根拠テキスト（旧データは設問文）を照合した目安です。
                          </p>
                          <ThesisCoverageSection
                            stats={thesisCoverageStats}
                            loadError={thesisCoverageError}
                          />
                        </section>
                      ) : null}
                      <section className="mt-10 border-t border-zinc-100 pt-8">
                        <h2 className="text-lg font-semibold text-zinc-950">テスト履歴</h2>
                        <p className="mt-1 text-sm text-zinc-600">
                          PDF・自動生成・過去プール由来のセッションのみ表示しています。
                        </p>
                        <QuizSessionHistoryList
                          testId={test.id}
                          sessions={mySessionsStandard}
                        />
                      </section>
                      <section className="mt-10 border-t border-zinc-100 pt-8">
                        <h2 className="text-lg font-semibold text-zinc-950">設問ごとの正答率</h2>
                        <p className="mt-1 text-sm text-zinc-600">
                          上記に合わせ、CSV 由来と推定した設問を除いた集計です。
                        </p>
                        {performanceLoadError ? (
                          <p className="mt-4 text-sm text-amber-800">
                            正答率の取得に失敗しました。Supabase の SQL エディタでリポジトリの{" "}
                            <code className="rounded bg-amber-100 px-1 py-0.5 text-xs">
                              supabase/sql_editor_question_performance.sql
                            </code>{" "}
                            を実行し（テーブル作成から権限・RPC まで一括）、必要なら PostgREST
                            のスキーマ再読み込みを行ってください。集計は提出が成功したあとに蓄積されます。
                          </p>
                        ) : (
                          <QuestionPerformanceSection rows={performanceRowsStandard} />
                        )}
                      </section>
                    </>
                  }
                  csvSlot={
                    <>
                      {csvUnderstandingBundle ? (
                        <section className="border-t border-zinc-100 pt-8">
                          <h2 className="text-lg font-semibold text-zinc-950">理解度</h2>
                          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500">
                            問題数（プール）と回答（試行）回数を示し、それと正答率から理解度の目安を出しています。クイズ／単語帳ごとの数値は下の折りたたみから開けます。
                          </p>
                          <CsvModeUnderstandingSections
                            bundle={csvUnderstandingBundle}
                            performanceLoadError={!!performanceLoadError}
                          />
                        </section>
                      ) : null}
                      <section className="mt-10 border-t border-zinc-100 pt-8">
                        <h2 className="text-lg font-semibold text-zinc-950">テスト履歴</h2>
                        <p className="mt-1 text-sm text-zinc-600">
                          CSV から出題したセッションを、クイズ／単語帳の別に表示しています。
                        </p>
                        <div className="mt-4 grid gap-6 lg:grid-cols-2">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-zinc-800">クイズ CSV</h3>
                            <QuizSessionHistoryList
                              testId={test.id}
                              sessions={csvSessionsByPool.quiz}
                            />
                          </div>
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-zinc-800">単語帳 CSV</h3>
                            <QuizSessionHistoryList
                              testId={test.id}
                              sessions={csvSessionsByPool.vocab}
                            />
                          </div>
                        </div>
                        {csvSessionsByPool.unknown.length > 0 ? (
                          <div className="mt-6 border-t border-dashed border-zinc-200 pt-6">
                            <h3 className="text-sm font-semibold text-zinc-600">種別未判定</h3>
                            <p className="mt-1 text-xs text-zinc-500">
                              古い履歴など、クイズ／単語帳に自動分類できなかったセッションです。
                            </p>
                            <QuizSessionHistoryList
                              testId={test.id}
                              sessions={csvSessionsByPool.unknown}
                            />
                          </div>
                        ) : null}
                      </section>
                      <section className="mt-10 border-t border-zinc-100 pt-8">
                        <h2 className="text-lg font-semibold text-zinc-950">設問ごとの正答率</h2>
                        <p className="mt-1 text-sm text-zinc-600">
                          CSV 由来の設問を、クイズ／単語帳の別に集計しています。
                        </p>
                        {performanceLoadError ? (
                          <p className="mt-4 text-sm text-amber-800">
                            正答率の取得に失敗しました。Supabase の SQL エディタでリポジトリの{" "}
                            <code className="rounded bg-amber-100 px-1 py-0.5 text-xs">
                              supabase/sql_editor_question_performance.sql
                            </code>{" "}
                            を実行し（テーブル作成から権限・RPC まで一括）、必要なら PostgREST
                            のスキーマ再読み込みを行ってください。集計は提出が成功したあとに蓄積されます。
                          </p>
                        ) : (
                          <div className="mt-4 grid gap-6 lg:grid-cols-2">
                            <div className="min-w-0">
                              <h3 className="text-sm font-semibold text-zinc-800">クイズ CSV</h3>
                              <QuestionPerformanceSection
                                rows={csvPerfByPool.quiz}
                                compact
                              />
                            </div>
                            <div className="min-w-0">
                              <h3 className="text-sm font-semibold text-zinc-800">単語帳 CSV</h3>
                              <QuestionPerformanceSection
                                rows={csvPerfByPool.vocab}
                                compact
                              />
                            </div>
                          </div>
                        )}
                      </section>
                    </>
                  }
                />
              </div>
            ) : (
              <>
                <div className="mt-8 flex flex-wrap items-start justify-between gap-4">
                  <div className="flex flex-wrap gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      {canMainStart ? (
                        <TestStartActionsByMode
                          mode="standard"
                          testId={test.id}
                          canPdfStart={canPdfStart}
                          canNbCsvQuizStart={canNbCsvQuizStart}
                          canNbCsvVocabStart={canNbCsvVocabStart}
                          mainTakeSearch={mainTakeSearch}
                          showRandomPast={mySessions.length > 0}
                          showReviewMistakes={showReviewMistakesStandard}
                          reviewMistakeCount={reviewMistakeCountStandard}
                        />
                      ) : (
                        <div className="flex max-w-md flex-col gap-1">
                          <button
                            type="button"
                            disabled
                            aria-disabled="true"
                            title="PDF 本文チャンク、またはクイズ／単語帳いずれかの NotebookLM CSV（各3問以上）が必要です"
                            className="cursor-not-allowed rounded-md bg-zinc-900 px-4 py-2 text-left text-sm font-medium text-white opacity-45"
                          >
                            テスト開始
                          </button>
                          <span className="text-xs text-zinc-500">
                            PDF から本文が取れず、かつ NotebookLM のクイズ CSV・単語帳
                            CSV のいずれも有効な問題が 3 問未満のため利用できません。
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {understandingModelMerged ? (
                  <section className="mt-10 border-t border-zinc-100 pt-8">
                    <h2 className="text-lg font-semibold text-zinc-950">理解度</h2>
                    <p className="mt-1 text-sm text-zinc-600">
                      論文では網羅率と設問の正答率の積（÷100）を理解度の目安にしています。過去問などは正答率のみです。
                    </p>
                    <UnderstandingSection
                      model={understandingModelMerged}
                      performanceLoadError={!!performanceLoadError}
                    />
                  </section>
                ) : null}

                {isPaper ? (
                  <section className="mt-10 border-t border-zinc-100 pt-8">
                    <h2 className="text-lg font-semibold text-zinc-950">論文の網羅率</h2>
                    <p className="mt-1 text-sm text-zinc-600">
                      PDF 本文のチャンクと、出題時に保存した根拠テキスト（旧データは設問文）を照合した目安です。
                    </p>
                    <ThesisCoverageSection
                      stats={thesisCoverageStats}
                      loadError={thesisCoverageError}
                    />
                  </section>
                ) : null}

                <section className="mt-10 border-t border-zinc-100 pt-8">
                  <h2 className="text-lg font-semibold text-zinc-950">テスト履歴</h2>
                  <p className="mt-1 text-sm text-zinc-600">
                    結果の確認と再テストができます。
                  </p>
                  <QuizSessionHistoryList testId={test.id} sessions={mySessions} />
                </section>

                <section className="mt-10 border-t border-zinc-100 pt-8">
                  <h2 className="text-lg font-semibold text-zinc-950">設問ごとの正答率</h2>
                  <p className="mt-1 text-sm text-zinc-600">
                    採点済みの結果から集計します。同じ内容の設問はまとめて表示されます。
                  </p>
                  {performanceLoadError ? (
                    <p className="mt-4 text-sm text-amber-800">
                      正答率の取得に失敗しました。Supabase の SQL エディタでリポジトリの{" "}
                      <code className="rounded bg-amber-100 px-1 py-0.5 text-xs">
                        supabase/sql_editor_question_performance.sql
                      </code>{" "}
                      を実行し（テーブル作成から権限・RPC まで一括）、必要なら PostgREST
                      のスキーマ再読み込みを行ってください。集計は提出が成功したあとに蓄積されます。
                    </p>
                  ) : (
                    <QuestionPerformanceSection rows={performanceRows} />
                  )}
                </section>
              </>
            )
          ) : (
            <div className="mt-8 flex flex-wrap items-start justify-between gap-4">
              <Link
                href="/auth/login"
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
              >
                ログインして受験
              </Link>
            </div>
          )
        ) : null}

        {user?.id && test.uploaded_by === user.id ? (
          <div className="mt-10 flex justify-end border-t border-zinc-100 pt-8">
            <TestDeleteButton testId={test.id} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
