"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildEgoGraphData,
  type EgoGraphData,
  type RelatedPapersResponse,
} from "@/lib/paper-related";
import { PaperGraphSvg } from "@/components/PaperGraphSvg";

type Props = {
  testId: string;
  title: string;
};

const SVG_WIDTH = 640;
const SVG_HEIGHT = 400;

export function PaperRelatedGraphSection({ testId, title: _title }: Props) {
  const router = useRouter();
  const [data, setData] = useState<RelatedPapersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/papers/${testId}/related`)
      .then(async (res) => {
        if (!res.ok) {
          const errJson = await res.json().catch(() => null);
          throw new Error(errJson?.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((json: RelatedPapersResponse) => {
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
              : "関連論文の取得に失敗しました",
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [testId]);

  const graph: EgoGraphData | null = data ? buildEgoGraphData(data) : null;

  const handleNodeClick = (nodeId: string) => {
    if (nodeId === testId) return;
    router.push(`/tests/${nodeId}`);
  };

  return (
    <section className="mt-10 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-950">
            関連論文グラフ
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            この論文を中心とした関連論文ネットワークです（内容類似・共著者）。
          </p>
        </div>

        {/* 凡例 */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-600">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-5 rounded bg-indigo-500" />
            <span>内容が近い（上位5件）</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-5 rounded bg-amber-500" />
            <span>共著者</span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="mt-6 flex h-64 items-center justify-center text-sm text-zinc-500">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
            <span>関連論文を検索中…</span>
          </div>
        </div>
      ) : error ? (
        <div className="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : !graph ? null : (
        <div className="mt-4">
          {/* 埋め込み未作成時の通知 */}
          {!graph.hasEmbedding ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <span className="font-semibold">※ 埋め込み未作成: </span>
              この論文にはベクトル埋め込みが作成されていないため、内容類似の関連論文は表示されません（共著者による関連のみ表示されます）。
            </div>
          ) : null}

          {/* 関連論文がない場合の表示 */}
          {!graph.hasRelated ? (
            <div className="flex h-56 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50 p-6 text-center">
              <p className="text-sm font-medium text-zinc-700">
                関連する論文は見つかりませんでした。
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                内容が類似する論文や、同一の著者による他の論文が登録されるとここにグラフが表示されます。
              </p>
            </div>
          ) : (
            <PaperGraphSvg
              nodes={graph.nodes}
              links={graph.links}
              width={SVG_WIDTH}
              height={SVG_HEIGHT}
              isEgoGraph={true}
              onNodeClick={handleNodeClick}
            />
          )}
        </div>
      )}
    </section>
  );
}
