"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from "d3-force";
import {
  buildEgoGraphData,
  type EgoGraphData,
  type EgoGraphLink,
  type EgoGraphNode,
  type RelatedPapersResponse,
} from "@/lib/paper-related";

type Props = {
  testId: string;
  title: string;
};

type TooltipState = {
  visible: boolean;
  x: number;
  y: number;
  title: string;
  detail: string;
  kind?: "node" | "similarity" | "coauthor";
};

const SVG_WIDTH = 640;
const SVG_HEIGHT = 400;

export function PaperRelatedGraphSection({ testId, title }: Props) {
  const router = useRouter();
  const [data, setData] = useState<RelatedPapersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    title: "",
    detail: "",
  });

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

  // d3-force によるレイアウト計算
  const graph = useMemo<EgoGraphData | null>(() => {
    if (!data) return null;
    const g = buildEgoGraphData(data);
    if (!g.hasRelated) return g;

    // ノードのコピーを作成してシミュレーションに投入
    const nodes: EgoGraphNode[] = g.nodes.map((n) => ({ ...n }));
    const centerNode = nodes.find((n) => n.isCenter);

    if (centerNode) {
      centerNode.fx = SVG_WIDTH / 2;
      centerNode.fy = SVG_HEIGHT / 2;
    }

    // 周辺ノードの初期位置を円周上に分散配置
    const neighbors = nodes.filter((n) => !n.isCenter);
    neighbors.forEach((n, idx) => {
      const angle = (2 * Math.PI * idx) / (neighbors.length || 1);
      const radius = 135;
      n.x = SVG_WIDTH / 2 + radius * Math.cos(angle);
      n.y = SVG_HEIGHT / 2 + radius * Math.sin(angle);
    });

    // d3-force links の準備（オブジェクト参照または ID）
    const simLinks = g.links.map((l) => ({
      ...l,
      source: l.source,
      target: l.target,
    }));

    const simulation = forceSimulation(nodes)
      .force(
        "link",
        forceLink(simLinks)
          .id((d) => (d as EgoGraphNode).id)
          .distance(140),
      )
      .force("charge", forceManyBody().strength(-300))
      .force("collide", forceCollide().radius(42))
      .force("center", forceCenter(SVG_WIDTH / 2, SVG_HEIGHT / 2));

    // 同期的に tick を進めて静的に安定した座標を決定
    simulation.tick(150);
    simulation.stop();

    const nodePositionMap = new Map(nodes.map((n) => [n.id, n]));

    return {
      ...g,
      nodes,
      links: g.links.map((l) => ({
        ...l,
        sourceNode: nodePositionMap.get(l.source),
        targetNode: nodePositionMap.get(l.target),
      })) as unknown as EgoGraphLink[],
    };
  }, [data]);

  const handleNodeClick = (nodeId: string) => {
    if (nodeId === testId) return;
    router.push(`/tests/${nodeId}`);
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!tooltip.visible) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip((prev) => ({
      ...prev,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }));
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
            <div className="relative overflow-hidden rounded-xl border border-zinc-100 bg-zinc-50/40">
              <svg
                viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
                className="h-auto w-full max-h-[460px] select-none"
                onMouseMove={handleMouseMove}
                onMouseLeave={() =>
                  setTooltip((prev) => ({ ...prev, visible: false }))
                }
              >
                {/* 辺（Links） */}
                <g className="links">
                  {graph.links.map((link) => {
                    const source = (link as unknown as { sourceNode?: EgoGraphNode }).sourceNode;
                    const target = (link as unknown as { targetNode?: EgoGraphNode }).targetNode;
                    if (!source || !target || source.x == null || source.y == null || target.x == null || target.y == null) {
                      return null;
                    }

                    const dx = target.x - source.x;
                    const dy = target.y - source.y;
                    const dist = Math.hypot(dx, dy) || 1;
                    const nx = -dy / dist;
                    const ny = dx / dist;
                    const midX = (source.x + target.x) / 2 + nx * link.curveOffset;
                    const midY = (source.y + target.y) / 2 + ny * link.curveOffset;

                    const pathD =
                      link.curveOffset === 0
                        ? `M ${source.x} ${source.y} L ${target.x} ${target.y}`
                        : `M ${source.x} ${source.y} Q ${midX} ${midY} ${target.x} ${target.y}`;

                    const isHovered = hoveredLinkId === link.id;
                    const isSimilarity = link.kind === "similarity";
                    const strokeColor = isSimilarity
                      ? isHovered
                        ? "#4338ca" // indigo-700
                        : "#6366f1" // indigo-500
                      : isHovered
                        ? "#b45309" // amber-700
                        : "#f59e0b"; // amber-500

                    const detailText = isSimilarity
                      ? `コサイン類似度: ${link.similarity ?? "—"}`
                      : `共通著者: ${link.commonAuthors?.join(", ") ?? "—"}`;

                    return (
                      <g key={link.id} className="link-group">
                        <title>
                          {isSimilarity
                            ? `内容類似 (${detailText})`
                            : `共著者 (${detailText})`}
                        </title>
                        {/* 判定エリア拡大用の透明線 */}
                        <path
                          d={pathD}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={20}
                          className="cursor-pointer"
                          onMouseEnter={(e) => {
                            setHoveredLinkId(link.id);
                            const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                            if (rect) {
                              setTooltip({
                                visible: true,
                                x: e.clientX - rect.left,
                                y: e.clientY - rect.top,
                                title: isSimilarity ? "内容類似" : "共著者",
                                detail: detailText,
                                kind: link.kind,
                              });
                            }
                          }}
                          onMouseLeave={() => {
                            setHoveredLinkId(null);
                            setTooltip((prev) => ({ ...prev, visible: false }));
                          }}
                        />
                        {/* 描画実線 */}
                        <path
                          d={pathD}
                          fill="none"
                          stroke={strokeColor}
                          strokeWidth={isHovered ? 4 : 2.5}
                          strokeDasharray={isSimilarity ? undefined : "6 3"}
                          className="transition-all duration-150 pointer-events-none"
                        />
                      </g>
                    );
                  })}
                </g>

                {/* ノード（Nodes） */}
                <g className="nodes">
                  {graph.nodes.map((node) => {
                    if (node.x == null || node.y == null) return null;
                    const isCenter = node.isCenter;
                    const isHovered = hoveredNodeId === node.id;
                    const radius = isCenter ? 26 : 20;

                    const titleSnippet =
                      node.title.length > 12
                        ? `${node.title.slice(0, 11)}…`
                        : node.title;

                    return (
                      <g
                        key={node.id}
                        transform={`translate(${node.x}, ${node.y})`}
                        className={`node-group ${
                          isCenter ? "cursor-default" : "cursor-pointer"
                        }`}
                        onClick={() => handleNodeClick(node.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            handleNodeClick(node.id);
                          }
                        }}
                        tabIndex={isCenter ? -1 : 0}
                        role={isCenter ? "img" : "button"}
                        aria-label={
                          isCenter
                            ? `中心論文: ${node.title}`
                            : `関連論文: ${node.title}`
                        }
                        onMouseEnter={(e) => {
                          setHoveredNodeId(node.id);
                          const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                          if (rect) {
                            setTooltip({
                              visible: true,
                              x: e.clientX - rect.left,
                              y: e.clientY - rect.top,
                              title: node.title,
                              detail: isCenter
                                ? "表示中の中心論文"
                                : "クリックでこの論文の詳細を表示",
                              kind: "node",
                            });
                          }
                        }}
                        onMouseLeave={() => {
                          setHoveredNodeId(null);
                          setTooltip((prev) => ({ ...prev, visible: false }));
                        }}
                      >
                        <title>
                          {node.title}
                          {isCenter ? " (中心論文)" : " (クリックで移動)"}
                        </title>

                        {/* ノード円 */}
                        <circle
                          r={radius}
                          fill={isCenter ? "#e0e7ff" : isHovered ? "#e0f2fe" : "#ffffff"}
                          stroke={
                            isCenter
                              ? "#4f46e5"
                              : isHovered
                                ? "#0284c7"
                                : "#64748b"
                          }
                          strokeWidth={isCenter ? 3.5 : isHovered ? 2.5 : 2}
                          className="transition-colors duration-150 shadow-sm"
                        />

                        {/* 中心マークまたはアイコン */}
                        {isCenter ? (
                          <text
                            textAnchor="middle"
                            dy="0.35em"
                            fontSize="11"
                            fontWeight="bold"
                            fill="#4338ca"
                            className="pointer-events-none select-none"
                          >
                            中心
                          </text>
                        ) : (
                          <text
                            textAnchor="middle"
                            dy="0.35em"
                            fontSize="10"
                            fontWeight="500"
                            fill="#334155"
                            className="pointer-events-none select-none"
                          >
                            論文
                          </text>
                        )}

                        {/* タイトルラベル */}
                        <text
                          textAnchor="middle"
                          y={radius + 15}
                          fontSize={isCenter ? "12" : "11"}
                          fontWeight={isCenter ? "600" : "500"}
                          fill={isCenter ? "#1e1b4b" : "#334155"}
                          className="pointer-events-none select-none"
                        >
                          {titleSnippet}
                        </text>
                      </g>
                    );
                  })}
                </g>
              </svg>

              {/* フローティングツールチップ */}
              {tooltip.visible ? (
                <div
                  className="pointer-events-none absolute z-20 max-w-xs -translate-x-1/2 -translate-y-full rounded-lg bg-zinc-900/95 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-sm transition-transform duration-75"
                  style={{
                    left: `${Math.max(80, Math.min(SVG_WIDTH - 80, tooltip.x))}px`,
                    top: `${Math.max(40, tooltip.y - 12)}px`,
                  }}
                >
                  <p className="font-semibold text-zinc-100">{tooltip.title}</p>
                  <p className="mt-0.5 text-zinc-300">{tooltip.detail}</p>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
