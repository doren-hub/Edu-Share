import { createClient } from "@/lib/supabase/server";
import { TestList } from "@/components/TestList";

export default async function Home() {
  const supabase = await createClient();
  const { data: tests } = await supabase
    .from("tests")
    .select(
      "id,title,description,source_type,source_name,processing_status,created_at,document_type",
    )
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">
          共有テストで学習を加速
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600">
          PDF（過去問・論文）をアップロードすると、Supabase Storage / DB / pgvector
          で取り込み、テスト開始のたびに Claude が選択式・記述式をランダムミックスで生成します。
        </p>
      </section>

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-lg font-semibold text-zinc-950">共有テスト一覧</h2>
        </div>
        <TestList tests={tests ?? []} />
      </section>
    </div>
  );
}
