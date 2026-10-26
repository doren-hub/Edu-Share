"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PaperGraphSvg } from "@/components/PaperGraphSvg";
import type { GlobalGraphResponse } from "@/lib/paper-related";

export function PaperGlobalGraphClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [selectedIndustry, setSelectedIndustry] = useState<string>(
    searchParams.get("industry") ?? "",
  );
  const [selectedYear, setSelectedYear] = useState<string>(
    searchParams.get("year") ?? "",
  );

  const [showSimilarity, setShowSimilarity] = useState(true);
  const [showCoauthor, setShowCoauthor] = useState(true);

  const [data, setData] = useState<GlobalGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // フィルター変更時に API からデータを取得
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (selectedIndustry) params.set("industry", selectedIndustry);
    if (selectedYear) params.set("year", selectedYear);
    params.set("k", "5");

    fetch(`/api/papers/graph?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((json: GlobalGraphResponse) => {
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "全体グラフデータの取得に失敗しました",
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedIndustry, selectedYear]);

  // URL クエリの同期
  const handleIndustryChange = (val: string) => {
    setSelectedIndustry(val);
    startTransition(() => {
      const p = new URLSearchParams(window.location.search);
      if (val) p.set("industry", val);
      else p.delete("industry");
      router.replace(`/tests/paper/graph${p.toString() ? `?${p.toString()}` : ""}`, {
        scroll: false,
      });
    });
  };

  const handleYearChange = (val: string) => {
    setSelectedYear(val);
    startTransition(() => {
      const p = new URLSearchParams(window.location.search);
      if (val) p.set("year", val);
      else p.delete("year");
      router.replace(`/tests/paper/graph${p.toString() ? `?${p.toString()}` : ""}`, {
        scroll: false,
      });
    });
  };

  const handleClearFilters = () => {
    setSelectedIndustry("");
    setSelectedYear("");
    startTransition(() => {
      router.replace("/tests/paper/graph", { scroll: false });
    });
  };

  const handleNodeClick = (nodeId: string) => {
    router.push(`/tests/${nodeId}`);
  };

  const hasFilter = Boolean(selectedIndustry || selectedYear);

  // リンク種類の集計
  const totalSimLinks =
    data?.links.filter((l) => l.kind === "similarity").length ?? 0;
  const totalCoLinks =
    data?.links.filter((l) => l.kind === "coauthor").length ?? 0;

  return (
    <div className="space-y-6">
      {/* 操作パネル（フィルター & 凡例トグル） */}
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          {/* 絞り込みセレクター */}
          <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
            <span className="text-xs font-semibold text-zinc-600">
              ノード絞り込み:
            </span>

            {/* 業界フィルター */}
            <div className="flex items-center gap-1.5">
              <label htmlFor="industry-filter" className="sr-only">
                業界
              </label>
              <select
                id="industry-filter"
                value={selectedIndustry}
                onChange={(e) => handleIndustryChange(e.target.value)}
                className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="">すべての業界</option>
                {data?.availableIndustries.map((ind) => (
                  <option key={ind} value={ind}>
                    {ind}
                  </option>
                ))}
                <option value="__empty__">（業界未設定）</option>
              </select>
            </div>

            {/* 発表年フィルター */}
            <div className="flex items-center gap-1.5">
              <label htmlFor="year-filter" className="sr-only">
                発表年
              </label>
              <select
                id="year-filter"
                value={selectedYear}
                onChange={(e) => handleYearChange(e.target.value)}
                className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="">すべての発表年</option>
                {data?.availableYears.map((yr) => (
                  <option key={yr} value={yr}>
                    {yr}年
                  </option>
                ))}
                <option value="__empty__">（発表年未設定）</option>
              </select>
            </div>

            {hasFilter ? (
              <button
                type="button"
                onClick={handleClearFilters}
                className="rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
              >
                絞り込み解除
              </button>
            ) : null}
          </div>

          {/* 凡例 & 表示切り替えトグル */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-zinc-100 text-xs md:border-t-0 md:pt-0">
            <span className="font-semibold text-zinc-600">辺の表示:</span>

            {/* 内容類似トグル */}
            <button
              type="button"
              onClick={() => setShowSimilarity((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-medium transition-all ${
                showSimilarity
                  ? "border-indigo-200 bg-indigo-50/70 text-indigo-900"
                  : "border-zinc-200 bg-zinc-50 text-zinc-400 line-through"
              }`}
              aria-pressed={showSimilarity}
              aria-label="内容が近い辺の表示切り替え"
            >
              <span
                className={`inline-block h-2 w-4 rounded-sm ${
                  showSimilarity ? "bg-indigo-500" : "bg-zinc-300"
                }`}
              />
              <span>内容が近い (k=5)</span>
              <span className="ml-0.5 text-[10px] text-zinc-500">
                ({totalSimLinks})
              </span>
            </button>

            {/* 共著者トグル */}
            <button
              type="button"
              onClick={() => setShowCoauthor((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-medium transition-all ${
                showCoauthor
                  ? "border-amber-200 bg-amber-50/70 text-amber-900"
                  : "border-zinc-200 bg-zinc-50 text-zinc-400 line-through"
              }`}
              aria-pressed={showCoauthor}
              aria-label="共著者辺の表示切り替え"
            >
              <span
                className={`inline-block h-2 w-4 rounded-sm border-t-2 border-b-2 border-dashed ${
                  showCoauthor
                    ? "border-amber-500 bg-amber-100"
                    : "border-zinc-300 bg-zinc-100"
                }`}
              />
              <span>共著者</span>
              <span className="ml-0.5 text-[10px] text-zinc-500">
                ({totalCoLinks})
              </span>
            </button>
          </div>
        </div>

        {/* 件数サマリー */}
        {data && !loading && !error && !data.exceeded ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
            <span>
              表示中: <strong className="text-zinc-800">{data.nodes.length}</strong> 件の論文
              {hasFilter ? `（全 ${data.totalCount} 件中）` : ""}
            </span>
            <span>·</span>
            <span>
              つながり:{" "}
              <strong className="text-zinc-800">
                {(showSimilarity ? totalSimLinks : 0) +
                  (showCoauthor ? totalCoLinks : 0)}
              </strong>{" "}
              本
            </span>
            <span className="text-zinc-400">
              ※ ノードをクリックすると論文詳細へ移動します。
            </span>
          </div>
        ) : null}

        {/* 一部取得エラー時の案内 */}
        {data?.partial ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
            ※ 一部の論文の類似度データを取得できなかったため、一部の「内容が近い」辺が表示されていない可能性があります。
          </div>
        ) : null}
      </section>

      {/* グラフ表示領域 */}
      {loading ? (
        <div className="flex h-96 items-center justify-center rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
          <div className="flex items-center gap-2">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
            <span>全体グラフを生成中…</span>
          </div>
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          <p className="font-semibold">グラフの読み込みエラー</p>
          <p className="mt-1">{error}</p>
        </div>
      ) : !data ? null : data.exceeded ? (
        /* 200件超過時の絞り込み促し表示 */
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-8 text-center sm:p-12">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h2 className="mt-4 text-base font-semibold text-zinc-900">
            論文数が200件を超えています（該当 {data.filteredCount} 件 / 全{" "}
            {data.totalCount} 件）
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-zinc-600">
            一度に大量の論文を描画すると画面が複雑になり判読が困難になるため、グラフは200件以下で描画されます。上の「業界」や「発表年」のフィルターを選択して対象を絞り込んでください。
          </p>
        </div>
      ) : data.nodes.length === 0 ? (
        /* 該当論文なし */
        <div className="flex h-80 flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-200 bg-white p-6 text-center">
          <p className="text-sm font-medium text-zinc-700">
            条件に一致する論文が見つかりませんでした。
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            業界や発表年の条件を変更するか、絞り込みを解除してお試しください。
          </p>
          {hasFilter ? (
            <button
              type="button"
              onClick={handleClearFilters}
              className="mt-4 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-zinc-800"
            >
              絞り込みをすべて解除
            </button>
          ) : null}
        </div>
      ) : (
        <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-6">
          <PaperGraphSvg
            nodes={data.nodes}
            links={data.links}
            width={840}
            height={560}
            isEgoGraph={false}
            showSimilarityLinks={showSimilarity}
            showCoauthorLinks={showCoauthor}
            onNodeClick={handleNodeClick}
          />
        </section>
      )}
    </div>
  );
}
