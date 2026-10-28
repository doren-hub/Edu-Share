import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { loadBookmarkMarks } from "@/lib/bookmarks";
import { loadPaperStudyStatuses } from "@/lib/paper-study-status";
import { createClient } from "@/lib/supabase/server";
import { TestsBrowseClient, TestsBrowseFallback } from "@/components/TestsBrowseClient";
import type { TestRow } from "@/components/TestList";
import { toPaperBrowseListRow } from "@/lib/paper-notebooklm-materials";
import { sanitizeBrowseTestRows } from "@/lib/sanitize-browse-test-row";
import { testBrowsePaperListColumns } from "@/lib/test-browse-select";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "論文｜EduShare",
  description: "論文PDFから生成したテスト教材の一覧です。",
};

export default async function PaperTestsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const pastCountQuery = supabase
    .from("tests")
    .select("id", { count: "exact", head: true })
    .or("document_type.eq.past_exam,document_type.is.null");

  const paperCountQuery = supabase
    .from("tests")
    .select("id", { count: "exact", head: true })
    .eq("document_type", "paper");

  const listQuery = supabase
    .from("tests")
    .select(testBrowsePaperListColumns(Boolean(user)))
    .eq("document_type", "paper")
    .order("created_at", { ascending: false });

  const [{ count: pastCount }, { count: paperCount }, listed, bookmarkMarks, studyStatuses] =
    await Promise.all([
      pastCountQuery,
      paperCountQuery,
      listQuery,
      loadBookmarkMarks(supabase),
      loadPaperStudyStatuses(supabase),
    ]);

  const tests = (listed.data ?? []) as unknown as Record<string, unknown>[];

  const list = sanitizeBrowseTestRows(
    tests.map((row) => toPaperBrowseListRow(row)) as TestRow[],
  );
  const globalEmpty = (pastCount ?? 0) + (paperCount ?? 0) === 0;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium tracking-wide text-violet-800">論文</p>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">
              論文一覧
            </h1>
          </div>
          <div>
            <Link
              href="/tests/paper/graph"
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50/70 px-3 py-1.5 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-100 hover:text-indigo-900"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              <span>全体グラフを見る</span>
            </Link>
          </div>
        </div>
        <p className="max-w-2xl text-sm text-zinc-600">
          論文PDFから取り込んだテストだけを表示しています。クイズCSV・単語帳CSV・スライド・動画が揃ったときだけ「受験可能」になります。足りない資料は「未」バッジで示します。業界・著者・発表年{studyStatuses.signedIn ? "・学習ステータス" : ""}とテキスト検索で絞り込み、並び順も選べます。
          {!globalEmpty ? (
            <span className="text-zinc-500">（全 {paperCount ?? list.length} 件）</span>
          ) : null}
        </p>
      </header>
      <Suspense fallback={<TestsBrowseFallback />}>
        <TestsBrowseClient
          tests={list}
          category="paper"
          globalEmpty={globalEmpty}
          bookmarkMarks={bookmarkMarks}
          showStudyStatus={studyStatuses.signedIn}
          studyStatuses={studyStatuses.byTestId}
          studyStatusError={studyStatuses.error}
        />
      </Suspense>
    </div>
  );
}
