import { createClient } from "@/lib/supabase/server";
import { TestList } from "@/components/TestList";

export default async function TestsPage() {
  const supabase = await createClient();
  const { data: tests } = await supabase
    .from("tests")
    .select(
      "id,title,description,source_type,source_name,processing_status,created_at,document_type",
    )
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-zinc-950">共有テスト一覧</h1>
      <TestList tests={tests ?? []} />
    </div>
  );
}
