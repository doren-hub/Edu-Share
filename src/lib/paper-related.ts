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

/**
 * ベクトルの要素ごとの平均（代表ベクトル）を算出する。
 * 有効なベクトルが無い場合は null を返す。
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
