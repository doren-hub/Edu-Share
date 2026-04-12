import Link from "next/link";

export type TestRow = {
  id: string;
  title: string;
  description: string | null;
  source_type: string;
  source_name: string;
  processing_status: string;
  created_at: string;
  document_type?: string | null;
};

export function TestList({ tests }: { tests: TestRow[] }) {
  if (!tests.length) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-sm text-zinc-600">
        まだ公開中のテストがありません。ログインしてPDFをアップロードすると共有一覧に表示されます。
      </p>
    );
  }

  return (
    <ul className="grid gap-3">
      {tests.map((t) => (
        <li key={t.id}>
          <Link
            href={`/tests/${t.id}`}
            className="block rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-zinc-950">{t.title}</h2>
                {t.description ? (
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-600">
                    {t.description}
                  </p>
                ) : null}
              </div>
              <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-700">
                {t.processing_status === "ready" ? "受験可能" : t.processing_status}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
              <span>
                出典:{" "}
                <span className="font-medium text-zinc-800">
                  {t.source_type === "school" ? "学校" : "専門家"}
                </span>{" "}
                / {t.source_name}
              </span>
              <span>
                種別:{" "}
                <span className="font-medium text-zinc-800">
                  {(t.document_type ?? "past_exam") === "paper" ? "論文" : "過去問"}
                </span>
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
