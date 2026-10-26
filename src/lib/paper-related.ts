import { isOtherBracketValue } from "./picklist-parse.ts";

export type RelatedTargetInfo = {
  id: string;
  title: string;
  hasEmbedding: boolean;
};

export type SimilarPaper = {
  id: string;
  title: string;
  similarity: number;
};

export type CoauthorPaper = {
  id: string;
  title: string;
  commonAuthors: string[];
};

export type RelatedPapersResponse = {
  target: RelatedTargetInfo;
  similarPapers: SimilarPaper[];
  coauthorPapers: CoauthorPaper[];
};

export type EgoGraphNode = {
  id: string;
  title: string;
  isCenter: boolean;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
};

export type EgoGraphLink = {
  id: string;
  source: string;
  target: string;
  kind: "similarity" | "coauthor";
  similarity?: number;
  commonAuthors?: string[];
  curveOffset: number;
};

export type EgoGraphData = {
  nodes: EgoGraphNode[];
  links: EgoGraphLink[];
  hasEmbedding: boolean;
  hasRelated: boolean;
};

export type GlobalGraphPaperCandidate = {
  id: string;
  title: string;
  industries?: string[];
  publicationYear?: string | null;
  authors: string[];
  similarCandidates?: Array<{ id: string; similarity: number }>;
};

export type GlobalGraphNode = {
  id: string;
  title: string;
  isCenter?: boolean;
  industries?: string[];
  publicationYear?: string | null;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
};

export type GlobalGraphLink = {
  id: string;
  source: string;
  target: string;
  kind: "similarity" | "coauthor";
  similarity?: number;
  commonAuthors?: string[];
  curveOffset: number;
};

export type GlobalGraphData = {
  nodes: GlobalGraphNode[];
  links: GlobalGraphLink[];
};

export type GlobalGraphResponse = {
  totalCount: number;
  filteredCount: number;
  exceeded: boolean;
  threshold: number;
  availableIndustries: string[];
  availableYears: string[];
  nodes: GlobalGraphNode[];
  links: GlobalGraphLink[];
  partial?: boolean;
};

/**
 * ベクトルの要素ごとの平均（代表ベクトル）を算出する。
 * SQL 側の match_related_papers (033_match_related_papers.sql) の代表ベクトル計算と同等の
 * 参照実装・仕様定義および単体テスト用。有効なベクトルが無い場合は null を返す。
 */
export function computeRepresentativeVector(
  embeddings: number[][],
): number[] | null {
  if (!Array.isArray(embeddings) || embeddings.length === 0) return null;

  const validVectors = embeddings.filter(
    (v) => Array.isArray(v) && v.length > 0 && v.every((n) => Number.isFinite(n)),
  );
  if (validVectors.length === 0) return null;

  const dim = validVectors[0].length;
  const sameDim = validVectors.filter((v) => v.length === dim);
  if (sameDim.length === 0) return null;

  const sum = new Array<number>(dim).fill(0);
  for (const vec of sameDim) {
    for (let i = 0; i < dim; i++) {
      sum[i] += vec[i];
    }
  }

  const count = sameDim.length;
  return sum.map((val) => val / count);
}

/**
 * 2つのベクトル間のコサイン類似度 (-1.0 〜 1.0) を算出する。
 * 次元が不一致または大きさが0の場合は 0 を返す。
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (
    !Array.isArray(vecA) ||
    !Array.isArray(vecB) ||
    vecA.length === 0 ||
    vecA.length !== vecB.length
  ) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  const mag = Math.sqrt(normA) * Math.sqrt(normB);
  if (mag === 0 || !Number.isFinite(mag)) return 0;

  const sim = dot / mag;
  // 浮動小数点誤差のクリッピング
  return Math.max(-1, Math.min(1, sim));
}

/**
 * 候補論文ベクトルの中から類似度が高い順に最大 k 件を抽出する。
 */
export function findTopSimilarPapers(
  targetVector: number[],
  candidates: Array<{ id: string; vector: number[] }>,
  k = 5,
): Array<{ id: string; similarity: number }> {
  const scored = candidates
    .map((c) => ({
      id: c.id,
      similarity: cosineSimilarity(targetVector, c.vector),
    }))
    .filter((c) => Number.isFinite(c.similarity));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, Math.max(1, k));
}

/**
 * 著者名を照合用に正規化する。
 * picklist の「その他（...）」を除去し、空白をトリムする。
 */
export function normalizeAuthorName(raw: string): string {
  const s = String(raw ?? "").trim();
  if (isOtherBracketValue(s)) {
    return s.slice(4, -1).trim();
  }
  return s;
}

/**
 * 2つの著者名が同一人物かを判定（大小文字無視・全角半角正規化・その他除外）
 */
export function areAuthorsEqual(a: string, b: string): boolean {
  const normA = normalizeAuthorName(a).toLowerCase();
  const normB = normalizeAuthorName(b).toLowerCase();
  return normA.length > 0 && normA === normB;
}

/**
 * 2つの著者リストの間で共通する著者名（表示用）を抽出する。
 */
export function findCommonAuthors(
  authorsA: string[],
  authorsB: string[],
): string[] {
  if (!Array.isArray(authorsA) || !Array.isArray(authorsB)) return [];

  const common: string[] = [];
  for (const a of authorsA) {
    const normA = normalizeAuthorName(a);
    if (!normA) continue;

    const matched = authorsB.some((b) => areAuthorsEqual(a, b));
    if (matched && !common.some((existing) => areAuthorsEqual(existing, normA))) {
      common.push(normA);
    }
  }

  return common;
}

/**
 * 候補論文群から、対象論文と共通の著者を持つ論文を抽出する。
 */
export function findCoauthorPapers<
  T extends { id: string; authors: string[]; title?: string },
>(
  targetAuthors: string[],
  candidates: T[],
): Array<{ paper: T; commonAuthors: string[] }> {
  const result: Array<{ paper: T; commonAuthors: string[] }> = [];

  for (const cand of candidates) {
    const common = findCommonAuthors(targetAuthors, cand.authors);
    if (common.length > 0) {
      result.push({ paper: cand, commonAuthors: common });
    }
  }

  return result;
}

/**
 * RelatedPapersResponse から ego グラフ（中心論文ノード + 関連ノード + 辺）の構造を構築する。
 * 内容類似と共著者の両方がある相手ノードには、2本の辺（反対方向にカーブ）を張る。
 */
export function buildEgoGraphData(data: RelatedPapersResponse): EgoGraphData {
  const { target, similarPapers = [], coauthorPapers = [] } = data;

  const centerNode: EgoGraphNode = {
    id: target.id,
    title: target.title || "対象論文",
    isCenter: true,
  };

  const neighborMap = new Map<string, EgoGraphNode>();

  for (const p of similarPapers) {
    if (p.id && p.id !== target.id && !neighborMap.has(p.id)) {
      neighborMap.set(p.id, {
        id: p.id,
        title: p.title || "関連論文",
        isCenter: false,
      });
    }
  }

  for (const p of coauthorPapers) {
    if (p.id && p.id !== target.id && !neighborMap.has(p.id)) {
      neighborMap.set(p.id, {
        id: p.id,
        title: p.title || "関連論文",
        isCenter: false,
      });
    }
  }

  const nodes: EgoGraphNode[] = [centerNode, ...neighborMap.values()];
  const links: EgoGraphLink[] = [];

  for (const neighborId of neighborMap.keys()) {
    const sim = similarPapers.find((p) => p.id === neighborId);
    const co = coauthorPapers.find((p) => p.id === neighborId);

    const hasBoth = Boolean(sim && co);

    if (sim) {
      links.push({
        id: `link-sim-${target.id}-${neighborId}`,
        source: target.id,
        target: neighborId,
        kind: "similarity",
        similarity: sim.similarity,
        curveOffset: hasBoth ? 16 : 0,
      });
    }

    if (co) {
      links.push({
        id: `link-co-${target.id}-${neighborId}`,
        source: target.id,
        target: neighborId,
        kind: "coauthor",
        commonAuthors: co.commonAuthors,
        curveOffset: hasBoth ? -16 : 0,
      });
    }
  }

  return {
    nodes,
    links,
    hasEmbedding: target.hasEmbedding,
    hasRelated: nodes.length > 1,
  };
}

/**
 * 2つのノード座標と curveOffset から SVG path の d 属性文字列を算出する。
 * offset が 0 のときは直線（L）、それ以外のときは二次ベジェ曲線（Q）を返す。
 */
export function computeLinkCurvePath(
  source: { x: number; y: number },
  target: { x: number; y: number },
  curveOffset: number,
): string {
  if (curveOffset === 0) {
    return `M ${source.x} ${source.y} L ${target.x} ${target.y}`;
  }
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const midX = (source.x + target.x) / 2 + nx * curveOffset;
  const midY = (source.y + target.y) / 2 + ny * curveOffset;
  return `M ${source.x} ${source.y} Q ${midX} ${midY} ${target.x} ${target.y}`;
}

/**
 * 業界（industries）および発表年（publication_year）で論文が絞り込み条件に一致するか判定する。
 */
export function matchesGraphFilter(
  paper: { industries?: string[]; publicationYear?: string | null },
  industry?: string,
  year?: string,
): boolean {
  if (industry) {
    const list = Array.isArray(paper.industries) ? paper.industries : [];
    if (industry === "__empty__") {
      if (list.length > 0) return false;
    } else {
      if (!list.includes(industry)) return false;
    }
  }

  if (year) {
    const y = (paper.publicationYear ?? "").trim();
    if (year === "__empty__") {
      if (y !== "") return false;
    } else {
      if (y !== year.trim()) return false;
    }
  }

  return true;
}

/**
 * 論文候補リストから全体グラフ（ノード + 辺）データを構築する。
 * - 内容類似辺: 各ノードについて候補論文群の中から類似度上位 k 件（デフォルト5件）を取り出し、無向辺として登録。
 * - 共著者辺: 共通著者を持つ論文対の間に登録。
 * - 同一ペア間に両方の辺が存在する場合は反対方向に curveOffset を付与して2本並行描画する。
 */
export function buildGlobalGraphData(
  papers: GlobalGraphPaperCandidate[],
  k = 5,
): GlobalGraphData {
  const paperMap = new Map<string, GlobalGraphPaperCandidate>();
  for (const p of papers) {
    paperMap.set(p.id, p);
  }

  const nodes: GlobalGraphNode[] = papers.map((p) => ({
    id: p.id,
    title: p.title || "論文",
    isCenter: false,
    industries: p.industries,
    publicationYear: p.publicationYear,
  }));

  // 1. 内容類似辺の抽出（各ノード上位 k 件、無向ペアの重複排除）
  // 各ノードから上位 k 件の類似候補を無向辺としてマージしているため、他ノードからの被選出により1ノードあたりの類似辺数は k 本以上になる場合があります（無向グラフとしての仕様）。
  type SimCandidateEdge = {
    source: string;
    target: string;
    similarity: number;
  };
  const simEdgeMap = new Map<string, SimCandidateEdge>();

  for (const paper of papers) {
    const candidates = (paper.similarCandidates ?? [])
      .filter((c) => c.id !== paper.id && paperMap.has(c.id))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.max(1, k));

    for (const cand of candidates) {
      const u = paper.id < cand.id ? paper.id : cand.id;
      const v = paper.id < cand.id ? cand.id : paper.id;
      const pairKey = `${u}_${v}`;
      const existing = simEdgeMap.get(pairKey);
      if (!existing || cand.similarity > existing.similarity) {
        simEdgeMap.set(pairKey, {
          source: u,
          target: v,
          similarity: cand.similarity,
        });
      }
    }
  }

  // 2. 共著者辺の抽出（共通著者を持つペア）
  type CoauthorCandidateEdge = {
    source: string;
    target: string;
    commonAuthors: string[];
  };
  const coEdgeMap = new Map<string, CoauthorCandidateEdge>();

  for (let i = 0; i < papers.length; i++) {
    for (let j = i + 1; j < papers.length; j++) {
      const p1 = papers[i];
      const p2 = papers[j];
      const common = findCommonAuthors(p1.authors, p2.authors);
      if (common.length > 0) {
        const u = p1.id < p2.id ? p1.id : p2.id;
        const v = p1.id < p2.id ? p2.id : p1.id;
        coEdgeMap.set(`${u}_${v}`, {
          source: u,
          target: v,
          commonAuthors: common,
        });
      }
    }
  }

  // 3. リンクの構築とカーブオフセット付与
  const links: GlobalGraphLink[] = [];
  const allPairKeys = new Set([...simEdgeMap.keys(), ...coEdgeMap.keys()]);

  for (const pairKey of allPairKeys) {
    const sim = simEdgeMap.get(pairKey);
    const co = coEdgeMap.get(pairKey);
    const hasBoth = Boolean(sim && co);

    if (sim) {
      links.push({
        id: `link-sim-${sim.source}-${sim.target}`,
        source: sim.source,
        target: sim.target,
        kind: "similarity",
        similarity: sim.similarity,
        curveOffset: hasBoth ? 16 : 0,
      });
    }

    if (co) {
      links.push({
        id: `link-co-${co.source}-${co.target}`,
        source: co.source,
        target: co.target,
        kind: "coauthor",
        commonAuthors: co.commonAuthors,
        curveOffset: hasBoth ? -16 : 0,
      });
    }
  }

  return { nodes, links };
}
