import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { TestsMaterialHub } from "@/components/TestsMaterialHub";
import { RecentTestsByCategory } from "@/components/TestList";
import { TEST_BROWSE_COLUMNS } from "@/lib/test-browse-select";

export const metadata: Metadata = {
  description:
    "入試の過去問や論文のPDFからテスト教材を作成し、区分別の一覧で閲覧・受験できます。直近に追加された教材も確認できます。",
};

const sectionShell =
  "rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8";

export default async function Home() {
  const supabase = await createClient();
  const { data: tests } = await supabase
    .from("tests")
    .select(TEST_BROWSE_COLUMNS)
    .order("created_at", { ascending: false });

  const list = tests ?? [];
  const pastN = list.filter((t) => (t.document_type ?? "past_exam") !== "paper").length;
  const paperN = list.filter((t) => t.document_type === "paper").length;

  return (
    <div className="space-y-8">
      <section className={sectionShell} aria-labelledby="home-hero-heading">
        <h1
          id="home-hero-heading"
          className="text-3xl font-semibold tracking-tight text-zinc-950"
        >
          テスト教材で学習を加速
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600">
          学校の入試過去問や論文のPDFをアップロードすると、資料が取り込まれ、受験のたびに選択式・記述式がミックスされたテストとして利用できます。一覧は次の区分から開きます。
        </p>
      </section>

      <section className={sectionShell} aria-label="テスト教材の区分別一覧">
        <TestsMaterialHub pastN={pastN} paperN={paperN} />
      </section>

      <RecentTestsByCategory tests={list} filter="all" />
    </div>
  );
}
