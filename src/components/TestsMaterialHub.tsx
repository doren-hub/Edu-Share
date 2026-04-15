import Link from "next/link";
import { createElement } from "react";
import { TESTS_LIST_PATHS } from "@/lib/tests-list-paths";

type TestsMaterialHubProps = {
  pastN: number;
  paperN: number;
};

/** ホーム等に埋め込む区分別への入口（見出しは h2、カード内は h3） */
export function TestsMaterialHub({ pastN, paperN }: TestsMaterialHubProps) {
  const cardClass =
    "group flex flex-col rounded-2xl border border-zinc-200/80 bg-zinc-50/90 p-6 shadow-sm ring-1 ring-zinc-100/80 transition hover:border-sky-300 hover:shadow-md";

  const cardClassPaper =
    "group flex flex-col rounded-2xl border border-zinc-200/80 bg-zinc-50/90 p-6 shadow-sm ring-1 ring-zinc-100/80 transition hover:border-violet-300 hover:shadow-md";

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        {createElement(
          "h2",
          { className: "text-2xl font-semibold tracking-tight text-zinc-950" },
          "テスト教材",
        )}
        <p className="max-w-2xl text-sm text-zinc-600">
          過去問（学校）と論文は、用途に応じて専用の一覧ページに分かれています。どちらかを選んでください。
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <Link href={TESTS_LIST_PATHS.pastExam} className={cardClass}>
          <span className="w-fit rounded-md bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-950">
            過去問（学校）
          </span>
          {createElement(
            "h3",
            { className: "mt-4 text-lg font-semibold text-zinc-950" },
            "学校の過去問",
          )}
          <p className="mt-2 flex-1 text-sm leading-6 text-zinc-600">
            入試過去問などをアップロードして生成したテスト教材を、学校名で絞り込みながら閲覧できます。
          </p>
          <p className="mt-4 text-xs text-zinc-500">{pastN} 件</p>
          <span className="mt-2 text-sm font-medium text-sky-900 group-hover:underline">
            一覧を開く →
          </span>
        </Link>

        <Link href={TESTS_LIST_PATHS.paper} className={cardClassPaper}>
          <span className="w-fit rounded-md bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-950">
            論文
          </span>
          {createElement(
            "h3",
            { className: "mt-4 text-lg font-semibold text-zinc-950" },
            "論文ベース",
          )}
          <p className="mt-2 flex-1 text-sm leading-6 text-zinc-600">
            論文PDFから生成したテスト教材を、著者・業界・発表年で絞り込みながら閲覧できます。
          </p>
          <p className="mt-4 text-xs text-zinc-500">{paperN} 件</p>
          <span className="mt-2 text-sm font-medium text-violet-900 group-hover:underline">
            一覧を開く →
          </span>
        </Link>
      </div>
    </div>
  );
}
