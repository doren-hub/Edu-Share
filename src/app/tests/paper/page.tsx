import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { TestsBrowseClient, TestsBrowseFallback } from "@/components/TestsBrowseClient";
import { TEST_BROWSE_PAPER_LIST_COLUMNS } from "@/lib/test-browse-select";

export const metadata: Metadata = {
  title: "論文｜EduShare",
  description: "論文PDFから生成したテスト教材の一覧です。",
};

export default async function PaperTestsPage() {
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
    .select(TEST_BROWSE_PAPER_LIST_COLUMNS)
    .eq("document_type", "paper")
    .order("created_at", { ascending: false });

  const [{ count: pastCount }, { count: paperCount }, { data: tests }] = await Promise.all([
    pastCountQuery,
    paperCountQuery,
    listQuery,
  ]);

  const list = tests ?? [];
  const globalEmpty = (pastCount ?? 0) + (paperCount ?? 0) === 0;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-medium tracking-wide text-violet-800">論文</p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">
          論文一覧
        </h1>
        <p className="max-w-2xl text-sm text-zinc-600">
          論文PDFから取り込んだテストだけを表示しています。未登録の NotebookLM
          資料（クイズCSV・単語帳CSV・スライド・動画）があるときだけ、カードに「未」バッジが付きます。業界・著者・発表年とテキスト検索で絞り込み、並び順も選べます。
          {!globalEmpty ? (
            <span className="text-zinc-500">（全 {paperCount ?? list.length} 件）</span>
          ) : null}
        </p>
      </header>
      <Suspense fallback={<TestsBrowseFallback />}>
        <TestsBrowseClient tests={list} category="paper" globalEmpty={globalEmpty} />
      </Suspense>
    </div>
  );
}
