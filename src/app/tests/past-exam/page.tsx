import type { Metadata } from "next";
import { Suspense } from "react";
import { loadBookmarkMarks } from "@/lib/bookmarks";
import { createClient } from "@/lib/supabase/server";
import { TestsBrowseClient, TestsBrowseFallback } from "@/components/TestsBrowseClient";
import { TEST_BROWSE_COLUMNS } from "@/lib/test-browse-select";

export const metadata: Metadata = {
  title: "過去問（学校）｜EduShare",
  description: "学校の入試過去問などから生成したテスト教材の一覧です。",
};

export default async function PastExamTestsPage() {
  const supabase = await createClient();

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
    .select(TEST_BROWSE_COLUMNS)
    .or("document_type.eq.past_exam,document_type.is.null")
    .order("created_at", { ascending: false });

  const [{ count: pastCount }, { count: paperCount }, { data: tests }, bookmarkMarks] =
    await Promise.all([
      pastCountQuery,
      paperCountQuery,
      listQuery,
      loadBookmarkMarks(supabase),
    ]);

  const list = tests ?? [];
  const globalEmpty = (pastCount ?? 0) + (paperCount ?? 0) === 0;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-medium tracking-wide text-sky-800">過去問（学校）</p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">
          学校の過去問テスト教材
        </h1>
        <p className="max-w-2xl text-sm text-zinc-600">
          入試過去問などをPDFから取り込んだテストだけを表示しています。学校名・テキスト検索で絞り込めます（追加が新しい順）。
          {!globalEmpty ? (
            <span className="text-zinc-500">（全 {pastCount ?? list.length} 件）</span>
          ) : null}
        </p>
      </header>
      <Suspense fallback={<TestsBrowseFallback />}>
        <TestsBrowseClient
          tests={list}
          category="past_exam"
          globalEmpty={globalEmpty}
          bookmarkMarks={bookmarkMarks}
        />
      </Suspense>
    </div>
  );
}
