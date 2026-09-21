"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { PaperAuthorsCollapsible } from "@/components/PaperAuthorsCollapsible";
import { PaperDoiInteractive } from "@/components/PaperDoiInteractive";
import { paperAuthorNamesForDisplay } from "@/lib/paper-authors";
import { normalizePaperDoiDisplay } from "@/lib/paper-doi";
import {
  paperNotebookLmMaterialsComplete,
  paperNotebookLmMissingLabels,
} from "@/lib/paper-notebooklm-materials";

export type TestRow = {
  id: string;
  title: string;
  description: string | null;
  source_type?: string;
  source_name: string;
  processing_status: string;
  processing_error?: string | null;
  created_at: string;
  document_type?: string | null;
  exam_department?: string | null;
  exam_subject?: string | null;
  exam_period?: string | null;
  industry?: string | null;
  publication_year?: string | null;
  paper_authors?: unknown;
  paper_venue?: string | null;
  paper_doi?: string | null;
  /** アップロード時の PDF ファイル名（論文の同一判定） */
  pdf_filename?: string | null;
  /** 論文一覧の資料バッジ用（省略時は未使用） */
  notebooklm_slide_pdf_storage_path?: string | null;
  notebooklm_video_mp4_storage_path?: string | null;
  notebooklm_questions_json?: unknown;
  notebooklm_vocab_questions_json?: unknown;
};

function PaperMaterialHints({ t, compact }: { t: TestRow; compact: boolean }) {
  const missing = paperNotebookLmMissingLabels(t);

  if (missing.length === 0) return null;

  const shell =
    compact
      ? "rounded border border-amber-200/90 bg-amber-50 px-1 py-0.5 text-[10px] font-medium leading-tight text-amber-950"
      : "rounded-md border border-amber-200/90 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-950";

  return (
    <div
      className={
        compact
          ? "flex flex-col items-end gap-1"
          : "flex flex-col items-end gap-1.5"
      }
      aria-label="未登録の NotebookLM 資料"
    >
      {missing.map(({ label }) => (
        <span key={label} className={shell} title={`${label}は未登録`}>
          {label}
          <span className="ml-0.5">未</span>
        </span>
      ))}
    </div>
  );
}

/** 論文カード（compact）で著者の後に続けるメタ（業界・年・掲載・DOI） */
function paperCompactTailStringsNoDoi(t: TestRow): string[] {
  return [
    t.industry ?? "",
    t.publication_year ? `${t.publication_year}年` : "",
    (t.paper_venue ?? "").trim(),
  ]
    .map((s) => String(s).trim())
    .filter(Boolean);
}

/** 最近追加（compact）用の1行サブタイトル（過去問のみ。論文は JSX で著者＋本配列） */
function formatCompactSourceLine(t: TestRow): string {
  return [
    t.source_name,
    t.exam_department ?? "",
    t.exam_subject ?? "",
    t.exam_period ?? "",
  ]
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(" · ") || "—";
}

function verboseMetaTitle(
  t: TestRow,
  hideSource: boolean,
  hideDocType: boolean,
): string | undefined {
  const parts: string[] = [];
  if (!hideSource) {
    if ((t.document_type ?? "past_exam") === "paper") {
      const authorNames = paperAuthorNamesForDisplay(
        t.paper_authors,
        t.source_name,
      );
      const authorsFull =
        authorNames.length > 0 ? authorNames.join(", ") : "—";
      const venue = (t.paper_venue ?? "").trim();
      const doi = normalizePaperDoiDisplay(t.paper_doi);
      parts.push(
        `著者: ${authorsFull}${t.industry || t.publication_year ? ` · 業界: ${t.industry ?? "—"} · 発表年: ${t.publication_year ? `${t.publication_year}年` : "—"}` : ""}${venue ? ` · 掲載: ${venue}` : ""}${doi ? ` · DOI: ${doi}` : ""}`,
      );
    } else {
      parts.push(
        `学校: ${t.source_name}${t.exam_department || t.exam_subject || t.exam_period ? ` · 学科: ${t.exam_department ?? "—"} · 科目: ${t.exam_subject ?? "—"} · 時期: ${t.exam_period ?? "—"}` : ""}`,
      );
    }
  }
  if (!hideDocType) {
    parts.push(
      `種別: ${(t.document_type ?? "past_exam") === "paper" ? "論文" : "過去問（学校）"}`,
    );
  }
  return parts.length ? parts.join(" / ") : undefined;
}

export function TestList({
  tests,
  hideDocumentTypeInCard = false,
  hideSourceInCard = false,
  emptyHint,
  compact = false,
  /** 論文一覧: NotebookLM の CSV・スライド・動画の有無バッジ */
  showPaperMaterialHints = false,
}: {
  tests: TestRow[];
  /** セクション見出しで区分済みのとき、カード内の種別表示を省略 */
  hideDocumentTypeInCard?: boolean;
  /** true のときカード内の出典行を省略 */
  hideSourceInCard?: boolean;
  /** 件数0のときの文言（省略時は既定の案内） */
  emptyHint?: string;
  /** true のとき余白・文字サイズを詰めた行（最近追加向け） */
  compact?: boolean;
  showPaperMaterialHints?: boolean;
}) {
  if (!tests.length) {
    return (
      <p
        className={
          compact
            ? "rounded-md border border-dashed border-zinc-200 bg-white/80 px-3 py-2 text-xs text-zinc-600"
            : "rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600"
        }
      >
        {emptyHint ??
          "まだ公開中のテストがありません。ログインしてPDFをアップロードすると、この一覧に表示されます。"}
      </p>
    );
  }

  return (
    <ul className={compact ? "grid gap-2" : "grid gap-3"}>
      {tests.map((t) => {
        const statusReadyOk =
          t.processing_status === "ready" && !t.processing_error;
        const paperMaterialsComplete =
          showPaperMaterialHints && paperNotebookLmMaterialsComplete(t);
        const statusBadgeBlue = statusReadyOk && paperMaterialsComplete;
        const statusLabel = (() => {
          if (t.processing_status === "ready" && t.processing_error) {
            return "テキスト未抽出";
          }
          if (t.processing_status !== "ready") return t.processing_status;
          if (showPaperMaterialHints && !paperMaterialsComplete) return "準備中";
          return "受験可能";
        })();
        return (
        <li key={t.id}>
          <Link
            href={`/tests/${t.id}`}
            data-pdf-filename={t.pdf_filename?.trim() || undefined}
            className={
              compact
                ? "block rounded-lg border border-zinc-200 bg-zinc-50/40 px-3 py-2.5 transition hover:border-zinc-300 hover:bg-white"
                : "block rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow"
            }
          >
            <div
              className={
                compact
                  ? "flex items-start justify-between gap-2"
                  : "flex flex-wrap items-start justify-between gap-3"
              }
            >
              <div className="min-w-0 flex-1">
                <h2
                  className={
                    compact
                      ? "truncate text-sm font-semibold leading-normal text-zinc-950"
                      : "text-lg font-semibold text-zinc-950"
                  }
                >
                  {t.title}
                </h2>
                {(t.document_type ?? "past_exam") === "paper" && t.pdf_filename?.trim() ? (
                  <p
                    className={
                      compact
                        ? "mt-0.5 truncate text-[11px] leading-snug text-zinc-500"
                        : "mt-1 truncate text-xs text-zinc-500"
                    }
                    title={t.pdf_filename.trim()}
                  >
                    PDF: {t.pdf_filename.trim()}
                  </p>
                ) : null}
                {!compact && t.description ? (
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-600">
                    {t.description}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {t.processing_status === "ready" && t.processing_error ? (
                    <span
                      className={
                        compact
                          ? "rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900"
                          : "rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-900"
                      }
                    >
                      テキスト未抽出
                    </span>
                  ) : (
                    <span
                      className={
                        compact
                          ? statusBadgeBlue
                            ? "rounded-md bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-900"
                            : "rounded-md bg-zinc-200/80 px-2 py-0.5 text-[11px] font-medium text-zinc-800"
                          : statusBadgeBlue
                            ? "rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-900"
                            : "rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-700"
                      }
                    >
                      {statusLabel}
                    </span>
                  )}
                </div>
                {showPaperMaterialHints ? (
                  <PaperMaterialHints t={t} compact={compact} />
                ) : null}
              </div>
            </div>
            {!hideSourceInCard || !hideDocumentTypeInCard ? (
              compact ? (
                <p
                  className={
                    (t.document_type ?? "past_exam") === "paper"
                      ? "mt-1.5 min-w-0 text-xs leading-snug text-zinc-600"
                      : "mt-1.5 min-w-0 truncate text-xs leading-snug text-zinc-600"
                  }
                  title={verboseMetaTitle(t, hideSourceInCard, hideDocumentTypeInCard)}
                >
                  {!hideSourceInCard ? (
                    (t.document_type ?? "past_exam") === "paper" ? (
                      <>
                        <PaperAuthorsCollapsible
                          paperAuthors={t.paper_authors}
                          sourceNameFallback={t.source_name}
                          compact
                        />
                        {(() => {
                          const strs = paperCompactTailStringsNoDoi(t);
                          const doiOk = normalizePaperDoiDisplay(t.paper_doi);
                          const tail: ReactNode[] = [...strs];
                          if (doiOk) {
                            tail.push(
                              <PaperDoiInteractive
                                key="doi"
                                paperDoi={t.paper_doi}
                                compact
                              />,
                            );
                          }
                          return tail.length > 0 ? (
                            <>
                              <span className="text-zinc-400"> · </span>
                              {tail.map((n, i) => (
                                <Fragment key={i}>
                                  {i > 0 ? (
                                    <span className="text-zinc-400"> · </span>
                                  ) : null}
                                  {n}
                                </Fragment>
                              ))}
                            </>
                          ) : null;
                        })()}
                      </>
                    ) : (
                      formatCompactSourceLine(t)
                    )
                  ) : null}
                  {!hideSourceInCard && !hideDocumentTypeInCard ? (
                    <span className="text-zinc-400"> · </span>
                  ) : null}
                  {!hideDocumentTypeInCard ? (
                    <span>
                      種別:{" "}
                      {(t.document_type ?? "past_exam") === "paper" ? "論文" : "過去問（学校）"}
                    </span>
                  ) : null}
                </p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
                  {!hideSourceInCard ? (
                    (t.document_type ?? "past_exam") === "paper" ? (
                      <span>
                        著者:{" "}
                        <span className="font-medium text-zinc-800">
                          <PaperAuthorsCollapsible
                            paperAuthors={t.paper_authors}
                            sourceNameFallback={t.source_name}
                          />
                        </span>
                        {(t.industry || t.publication_year) ? (
                          <>
                            {" · "}
                            業界:{" "}
                            <span className="font-medium text-zinc-800">
                              {t.industry ?? "—"}
                            </span>
                            {" · "}
                            発表年:{" "}
                            <span className="font-medium text-zinc-800">
                              {t.publication_year
                                ? `${t.publication_year}年`
                                : "—"}
                            </span>
                          </>
                        ) : null}
                        {(t.paper_venue ?? "").trim() ? (
                          <>
                            {" · "}
                            掲載:{" "}
                            <span className="font-medium text-zinc-800">
                              {(t.paper_venue ?? "").trim()}
                            </span>
                          </>
                        ) : null}
                        {normalizePaperDoiDisplay(t.paper_doi) ? (
                          <>
                            {" · "}
                            DOI:{" "}
                            <PaperDoiInteractive paperDoi={t.paper_doi} />
                          </>
                        ) : null}
                      </span>
                    ) : (
                      <span>
                        学校:{" "}
                        <span className="font-medium text-zinc-800">
                          {t.source_name}
                        </span>
                        {(t.exam_department || t.exam_subject || t.exam_period) ? (
                          <>
                            {" · "}
                            学科:{" "}
                            <span className="font-medium text-zinc-800">
                              {t.exam_department ?? "—"}
                            </span>
                            {" · "}
                            科目:{" "}
                            <span className="font-medium text-zinc-800">
                              {t.exam_subject ?? "—"}
                            </span>
                            {" · "}
                            時期:{" "}
                            <span className="font-medium text-zinc-800">
                              {t.exam_period ?? "—"}
                            </span>
                          </>
                        ) : null}
                      </span>
                    )
                  ) : null}
                  {!hideDocumentTypeInCard ? (
                    <span>
                      種別:{" "}
                      <span className="font-medium text-zinc-800">
                        {(t.document_type ?? "past_exam") === "paper"
                          ? "論文"
                          : "過去問（学校）"}
                      </span>
                    </span>
                  ) : null}
                </div>
              )
            ) : null}
          </Link>
        </li>
        );
      })}
    </ul>
  );
}

const RECENT_TESTS_LIMIT = 5;

export type RecentTestsFilter = "all" | "past_exam" | "paper";

/** テスト教材一覧用: 区分ごとに追加が新しい順で最大5件。filter で片方のみ表示可 */
export function RecentTestsByCategory({
  tests,
  filter = "all",
}: {
  tests: TestRow[];
  filter?: RecentTestsFilter;
}) {
  const pastExams = tests.filter((t) => (t.document_type ?? "past_exam") !== "paper");
  const papers = tests.filter((t) => t.document_type === "paper");
  const recentPast = pastExams.slice(0, RECENT_TESTS_LIMIT);
  const recentPapers = papers.slice(0, RECENT_TESTS_LIMIT);

  const oneColumn = filter === "past_exam" || filter === "paper";
  const stackVertical = filter === "all";

  return (
    <section
      className="space-y-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8"
      aria-labelledby="recent-tests-heading"
    >
      <header className="space-y-2">
        <h2
          id="recent-tests-heading"
          className="text-2xl font-semibold tracking-tight text-zinc-950"
        >
          最近追加
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-zinc-600">
          {filter === "past_exam"
            ? `過去問（学校）のみ表示します。登録が新しい順で、最大${RECENT_TESTS_LIMIT}件です。`
            : filter === "paper"
              ? `論文のみ表示します。登録が新しい順で、最大${RECENT_TESTS_LIMIT}件です。`
              : `上から過去問（学校）、続けて論文の順です。区分ごとに登録が新しい順で、それぞれ最大${RECENT_TESTS_LIMIT}件まで表示します。`}
        </p>
      </header>

      <div
        className={
          stackVertical
            ? "space-y-6"
            : oneColumn
              ? "max-w-2xl space-y-3"
              : "space-y-3"
        }
      >
        {filter !== "paper" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="w-fit rounded-md bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-950">
                過去問（学校）
              </span>
              <span className="text-sm text-zinc-500">
                {recentPast.length > 0 ? `${recentPast.length}件` : "該当なし"}
              </span>
            </div>
            {recentPast.length > 0 ? (
              <TestList tests={recentPast} hideDocumentTypeInCard compact />
            ) : (
              <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/80 px-3 py-3 text-sm text-zinc-600">
                過去問（学校）として登録されたテストはまだありません。
              </p>
            )}
          </div>
        ) : null}
        {filter !== "past_exam" ? (
          <div
            className={
              stackVertical
                ? "space-y-3 border-t border-zinc-200 pt-6"
                : "space-y-3"
            }
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="w-fit rounded-md bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-950">
                論文
              </span>
              <span className="text-sm text-zinc-500">
                {recentPapers.length > 0 ? `${recentPapers.length}件` : "該当なし"}
              </span>
            </div>
            {recentPapers.length > 0 ? (
              <TestList tests={recentPapers} hideDocumentTypeInCard compact />
            ) : (
              <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/80 px-3 py-3 text-sm text-zinc-600">
                論文として登録されたテストはまだありません。
              </p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

