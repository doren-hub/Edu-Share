import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { TestsBrowseClient, TestsBrowseFallback } from "@/components/TestsBrowseClient";
import type { TestRow } from "@/components/TestList";
import { toPaperBrowseListRow } from "@/lib/paper-notebooklm-materials";
import { TEST_BROWSE_PAPER_LIST_COLUMNS } from "@/lib/test-browse-select";

export const dynamic = "force-dynamic";

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

  const [{ count: pastCount }, { count: paperCount }, listed] = await Promise.all([
    pastCountQuery,
    paperCountQuery,
    listQuery,
  ]);

  const tests = (listed.data ?? []) as unknown as Record<string, unknown>[];

  const list = tests.map((row) => toPaperBrowseListRow(row)) as TestRow[];
  const globalEmpty = (pastCount ?? 0) + (paperCount ?? 0) === 0;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs font-medium tracking-wide text-violet-800">論文</p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-950">
          論文一覧
        </h1>
        <p className="max-w-2xl text-sm text-zinc-600">
          論文PDFから取り込んだテストだけを表示しています。クイズCSV・単語帳CSV・スライド・動画が揃ったときだけ「受験可能」になります。足りない資料は「未」バッジで示します。業界・著者・発表年とテキスト検索で絞り込み、並び順も選べます。
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
