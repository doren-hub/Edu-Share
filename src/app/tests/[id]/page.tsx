import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function TestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: test } = await supabase
    .from("tests")
    .select(
      "id,title,description,source_type,source_name,processing_status,processing_error,created_at,document_type",
    )
    .eq("id", id)
    .single();

  if (!test) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
            <dt className="text-zinc-500">出典タイプ</dt>
            <dd className="font-medium text-zinc-900">
              {test.source_type === "school" ? "学校" : "専門家"}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">出典名</dt>
            <dd className="font-medium text-zinc-900">{test.source_name}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">資料</dt>
            <dd className="font-medium text-zinc-900">
              {(test.document_type ?? "past_exam") === "paper" ? "論文" : "過去問"}
            </dd>
          </div>
        </dl>

        {test.processing_status === "failed" && test.processing_error ? (
          <p className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            取り込み失敗: {test.processing_error}
          </p>
        ) : null}

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/tests"
            className="rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm hover:bg-zinc-50"
          >
            一覧へ
          </Link>

          {test.processing_status === "ready" ? (
            user ? (
              <Link
                href={`/tests/${test.id}/take`}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
              >
                テスト開始（毎回生成）
              </Link>
            ) : (
              <Link
                href="/auth/login"
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
              >
                ログインして受験
              </Link>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
