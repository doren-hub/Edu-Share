"use client";

import { useMemo, useState } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from "d3-force";
import {
  computeLinkCurvePath,
  type GlobalGraphNode,
  type GlobalGraphLink,
} from "@/lib/paper-related";

export type PaperGraphSvgProps = {
  nodes: GlobalGraphNode[];
  links: GlobalGraphLink[];
  width?: number;
  height?: number;
  isEgoGraph?: boolean;
  showSimilarityLinks?: boolean;
  showCoauthorLinks?: boolean;
  onNodeClick?: (nodeId: string) => void;
};

type TooltipState = {
  visible: boolean;
  x: number;
  y: number;
  containerWidth: number;
  title: string;
  detail: string;
  kind?: "node" | "similarity" | "coauthor";
};

export function PaperGraphSvg({
  nodes: inputNodes,
  links: inputLinks,
  width = 800,
  height = 520,
  isEgoGraph = false,
  showSimilarityLinks = true,
  showCoauthorLinks = true,
  onNodeClick,
}: PaperGraphSvgProps) {
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    containerWidth: width,
    title: "",
    detail: "",
  });

  // d3-force による力学レイアウト座標の算出
  const computedGraph = useMemo(() => {
    if (inputNodes.length === 0) {
      return { nodes: [], links: [] };
    }

    // ノードのディープコピーを作成
    const simNodes: GlobalGraphNode[] = inputNodes.map((n) => ({ ...n }));
    const centerNode = simNodes.find((n) => n.isCenter);

    if (isEgoGraph && centerNode) {
      centerNode.fx = width / 2;
      centerNode.fy = height / 2;

      // 周辺ノードの初期位置を円周上に分散配置
      const neighbors = simNodes.filter((n) => !n.isCenter);
      neighbors.forEach((n, idx) => {
        const angle = (2 * Math.PI * idx) / (neighbors.length || 1);
        const radius = Math.min(width, height) * 0.35;
        n.x = width / 2 + radius * Math.cos(angle);
        n.y = height / 2 + radius * Math.sin(angle);
      });
    } else {
      // 全体グラフの場合: 初期配置を円周上等間隔に配置してシミュレーションを開始
      simNodes.forEach((n, idx) => {
        const angle = (2 * Math.PI * idx) / (simNodes.length || 1);
        const radius = Math.min(width, height) * 0.38;
        n.x = width / 2 + radius * Math.cos(angle);
        n.y = height / 2 + radius * Math.sin(angle);
      });
    }

    const simLinks = inputLinks.map((l) => ({
      ...l,
      source: l.source,
      target: l.target,
    }));

    const simulation = forceSimulation(simNodes)
      .force(
        "link",
        forceLink(simLinks)
          .id((d) => (d as GlobalGraphNode).id)
          .distance(isEgoGraph ? 140 : 100),
      )
      .force("charge", forceManyBody().strength(isEgoGraph ? -300 : -220))
      .force("collide", forceCollide().radius(isEgoGraph ? 42 : 36))
      .force("center", forceCenter(width / 2, height / 2));

    simulation.tick(160);
    simulation.stop();

    // 座標が境界から極端にはみ出さないよう微クランプ
    const pad = 36;
    for (const n of simNodes) {
      if (n.x != null) n.x = Math.max(pad, Math.min(width - pad, n.x));
      if (n.y != null) n.y = Math.max(pad, Math.min(height - pad, n.y));
    }

    const nodePositionMap = new Map(simNodes.map((n) => [n.id, n]));

    const computedLinks = inputLinks.map((l) => ({
      ...l,
      sourceNode: nodePositionMap.get(
        typeof l.source === "object" ? (l.source as GlobalGraphNode).id : l.source,
      ),
      targetNode: nodePositionMap.get(
        typeof l.target === "object" ? (l.target as GlobalGraphNode).id : l.target,
      ),
    }));

    return {
      nodes: simNodes,
      links: computedLinks,
    };
  }, [inputNodes, inputLinks, width, height, isEgoGraph]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!tooltip.visible) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip((prev) => ({
      ...prev,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      containerWidth: rect.width,
    }));
  };

  // 表示対象のリンク
  const visibleLinks = computedGraph.links.filter((l) => {
    if (l.kind === "similarity" && !showSimilarityLinks) return false;
    if (l.kind === "coauthor" && !showCoauthorLinks) return false;
    return true;
  });

  return (
    <div className="relative overflow-hidden rounded-xl border border-zinc-100 bg-zinc-50/40">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full max-h-[580px] select-none touch-manipulation"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip((prev) => ({ ...prev, visible: false }))}
      >
        {/* 辺（Links） */}
        <g className="links">
          {visibleLinks.map((link) => {
            const source = link.sourceNode;
            const target = link.targetNode;
            if (
              !source ||
              !target ||
              source.x == null ||
              source.y == null ||
              target.x == null ||
              target.y == null
            ) {
              return null;
            }

            const pathD = computeLinkCurvePath(
              { x: source.x, y: source.y },
              { x: target.x, y: target.y },
              link.curveOffset,
            );

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
                    const rect =
                      e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                    if (rect) {
                      setTooltip({
                        visible: true,
                        x: e.clientX - rect.left,
                        y: e.clientY - rect.top,
                        containerWidth: rect.width,
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
                  className="pointer-events-none transition-all duration-150"
                />
              </g>
            );
          })}
        </g>

        {/* ノード（Nodes） */}
        <g className="nodes">
          {computedGraph.nodes.map((node) => {
            if (node.x == null || node.y == null) return null;
            const isCenter = Boolean(node.isCenter);
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
                onClick={() => onNodeClick?.(node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    onNodeClick?.(node.id);
                  }
                }}
                tabIndex={isCenter ? -1 : 0}
                role={isCenter ? "img" : "button"}
                aria-label={
                  isCenter
                    ? `中心論文: ${node.title}`
                    : `論文: ${node.title}`
                }
                onMouseEnter={(e) => {
                  setHoveredNodeId(node.id);
                  const rect =
                    e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                  if (rect) {
                    const metaParts: string[] = [];
                    if (node.industries && node.industries.length > 0) {
                      metaParts.push(`業界: ${node.industries.join(", ")}`);
                    }
                    if (node.publicationYear) {
                      metaParts.push(`発表年: ${node.publicationYear}年`);
                    }
                    const detail = isCenter
                      ? "表示中の中心論文"
                      : metaParts.length > 0
                        ? `${metaParts.join(" · ")} (クリックで詳細へ)`
                        : "クリックでこの論文の詳細を表示";

                    setTooltip({
                      visible: true,
                      x: e.clientX - rect.left,
                      y: e.clientY - rect.top,
                      containerWidth: rect.width,
                      title: node.title,
                      detail,
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
                  fill={
                    isCenter ? "#e0e7ff" : isHovered ? "#e0f2fe" : "#ffffff"
                  }
                  stroke={
                    isCenter
                      ? "#4f46e5"
                      : isHovered
                        ? "#0284c7"
                        : "#64748b"
                  }
                  strokeWidth={isCenter ? 3.5 : isHovered ? 2.5 : 2}
                  className="shadow-sm transition-colors duration-150"
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
            left: `${Math.max(
              80,
              Math.min(
                Math.max(80, (tooltip.containerWidth || width) - 80),
                tooltip.x,
              ),
            )}px`,
            top: `${Math.max(40, tooltip.y - 12)}px`,
          }}
        >
          <p className="font-semibold text-zinc-100">{tooltip.title}</p>
          <p className="mt-0.5 text-zinc-300">{tooltip.detail}</p>
        </div>
      ) : null}
    </div>
  );
}
