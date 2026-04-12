import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ResultPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id: testId, sessionId } = await params;
  const supabase = await createClient();

  const { data: session } = await supabase
    .from("quiz_sessions")
    .select(
      "id,score_total,score_mc,score_essay,feedback_json,created_at,test_id",
    )
    .eq("id", sessionId)
    .single();

  if (!session) notFound();
  if (session.test_id !== testId) notFound();

  const { data: testRow } = await supabase
    .from("tests")
    .select("title")
    .eq("id", session.test_id)
    .single();

  const title = testRow?.title ?? "テスト";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">
          採点結果
        </h1>
        <p className="mt-2 text-sm text-zinc-600">{title}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <p className="text-xs text-zinc-500">総合</p>
          <p className="mt-2 text-3xl font-semibold text-zinc-950">
            {session.score_total ?? "-"}
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <p className="text-xs text-zinc-500">選択式（100点換算）</p>
          <p className="mt-2 text-3xl font-semibold text-zinc-950">
            {session.score_mc ?? "-"}
          </p>
        </div>
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <p className="text-xs text-zinc-500">記述式（100点換算）</p>
          <p className="mt-2 text-3xl font-semibold text-zinc-950">
            {session.score_essay ?? "-"}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-zinc-950">講評（JSON）</h2>
        <pre className="mt-4 max-h-[420px] overflow-auto rounded-md bg-zinc-950 p-4 text-xs text-zinc-50">
          {JSON.stringify(session.feedback_json ?? {}, null, 2)}
        </pre>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href={`/tests/${testId}`}
          className="rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm hover:bg-zinc-50"
        >
          テスト詳細へ
        </Link>
        <Link
          href={`/tests/${testId}/take`}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          もう一度受験（再生成）
        </Link>
      </div>
    </div>
  );
}
