import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRepresentativeVector,
  cosineSimilarity,
  findTopSimilarPapers,
  normalizeAuthorName,
  areAuthorsEqual,
  findCommonAuthors,
  findCoauthorPapers,
  buildEgoGraphData,
  computeLinkCurvePath,
  matchesGraphFilter,
  buildGlobalGraphData,
  isSignatureMismatchError,
  fetchSimilarCandidatesForPaper,
  type RelatedPapersResponse,
  type GlobalGraphPaperCandidate,
  type RpcCaller,
} from "./paper-related.ts";

test("computeRepresentativeVector: returns correct element-wise mean", () => {
  const v1 = [1, 2, 3];
  const v2 = [3, 4, 5];
  const avg = computeRepresentativeVector([v1, v2]);
  assert.deepEqual(avg, [2, 3, 4]);

  // Single vector
  assert.deepEqual(computeRepresentativeVector([[10, 20]]), [10, 20]);

  // Empty or invalid
  assert.equal(computeRepresentativeVector([]), null);
  assert.equal(computeRepresentativeVector([[NaN, 1]]), null);
});

test("cosineSimilarity: computes cosine similarity correctly", () => {
  // Identical vectors -> 1
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);

  // Orthogonal vectors -> 0
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);

  // Opposite vectors -> -1
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);

  // Scaled identical vectors -> 1
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-6);

  // Dimension mismatch or zero vector -> 0
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test("findTopSimilarPapers: sorts and limits to top k", () => {
  const target = [1, 0, 0];
  const candidates = [
    { id: "p1", vector: [0, 1, 0] }, // sim 0
    { id: "p2", vector: [0.9, 0.1, 0] }, // high sim
    { id: "p3", vector: [0.7, 0.7, 0] }, // medium sim
    { id: "p4", vector: [1, 0, 0] }, // sim 1.0
  ];

  const top2 = findTopSimilarPapers(target, candidates, 2);
  assert.equal(top2.length, 2);
  assert.equal(top2[0].id, "p4");
  assert.equal(top2[1].id, "p2");
});

test("normalizeAuthorName & areAuthorsEqual: normalizes その他 and case", () => {
  assert.equal(normalizeAuthorName("  山田 太郎  "), "山田 太郎");
  assert.equal(normalizeAuthorName("その他（佐藤 花子）"), "佐藤 花子");
  assert.equal(normalizeAuthorName("その他（  John Doe  ）"), "John Doe");

  assert.equal(areAuthorsEqual("山田 太郎", "山田 太郎"), true);
  assert.equal(areAuthorsEqual("その他（山田 太郎）", "山田 太郎"), true);
  assert.equal(areAuthorsEqual("Alan Turing", "alan turing"), true);
  assert.equal(areAuthorsEqual("Alice", "Bob"), false);
});

test("findCommonAuthors: extracts common author names without duplicates", () => {
  const authorsA = ["その他（山田 太郎）", "佐藤 花子", "鈴木 一郎"];
  const authorsB = ["田中 次郎", "山田 太郎", "佐藤 花子"];

  const common = findCommonAuthors(authorsA, authorsB);
  assert.deepEqual(common, ["山田 太郎", "佐藤 花子"]);

  // No common authors
  assert.deepEqual(findCommonAuthors(["Alice"], ["Bob"]), []);
});

test("findCoauthorPapers: filters candidates sharing authors", () => {
  const targetAuthors = ["山田 太郎", "佐藤 花子"];
  const candidates = [
    { id: "1", title: "Paper 1", authors: ["田中 次郎"] },
    { id: "2", title: "Paper 2", authors: ["その他（山田 太郎）", "木村 拓"] },
    { id: "3", title: "Paper 3", authors: ["佐藤 花子", "山田 太郎"] },
  ];

  const result = findCoauthorPapers(targetAuthors, candidates);
  assert.equal(result.length, 2);
  assert.equal(result[0].paper.id, "2");
  assert.deepEqual(result[0].commonAuthors, ["山田 太郎"]);
  assert.equal(result[1].paper.id, "3");
  assert.deepEqual(result[1].commonAuthors, ["山田 太郎", "佐藤 花子"]);
});

test("buildEgoGraphData: builds nodes and links with curve offsets", () => {
  const mockData: RelatedPapersResponse = {
    target: { id: "center", title: "Center Paper", hasEmbedding: true },
    similarPapers: [
      { id: "sim-only", title: "Sim Only Paper", similarity: 0.85 },
      { id: "both", title: "Both Paper", similarity: 0.92 },
    ],
    coauthorPapers: [
      { id: "both", title: "Both Paper", commonAuthors: ["山田 太郎"] },
      { id: "co-only", title: "Co Only Paper", commonAuthors: ["佐藤 花子"] },
    ],
  };

  const graph = buildEgoGraphData(mockData);
  assert.equal(graph.hasEmbedding, true);
  assert.equal(graph.hasRelated, true);

  // Nodes: center + 3 unique neighbors = 4
  assert.equal(graph.nodes.length, 4);
  const center = graph.nodes.find((n) => n.id === "center");
  assert.ok(center?.isCenter);

  // Links:
  // sim-only: 1 link (similarity, offset 0)
  // co-only: 1 link (coauthor, offset 0)
  // both: 2 links (similarity offset 16, coauthor offset -16)
  assert.equal(graph.links.length, 4);

  const simOnlyLink = graph.links.find((l) => l.target === "sim-only");
  assert.ok(simOnlyLink);
  assert.equal(simOnlyLink.kind, "similarity");
  assert.equal(simOnlyLink.curveOffset, 0);

  const coOnlyLink = graph.links.find((l) => l.target === "co-only");
  assert.ok(coOnlyLink);
  assert.equal(coOnlyLink.kind, "coauthor");
  assert.equal(coOnlyLink.curveOffset, 0);

  const bothLinks = graph.links.filter((l) => l.target === "both");
  assert.equal(bothLinks.length, 2);
  const bothSim = bothLinks.find((l) => l.kind === "similarity");
  const bothCo = bothLinks.find((l) => l.kind === "coauthor");
  assert.equal(bothSim?.curveOffset, 16);
  assert.equal(bothCo?.curveOffset, -16);
});

test("buildEgoGraphData: handles no relations and no embeddings", () => {
  const emptyData: RelatedPapersResponse = {
    target: { id: "center", title: "Lonely Paper", hasEmbedding: false },
    similarPapers: [],
    coauthorPapers: [],
  };

  const graph = buildEgoGraphData(emptyData);
  assert.equal(graph.hasEmbedding, false);
  assert.equal(graph.hasRelated, false);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.links.length, 0);
});

test("computeLinkCurvePath: generates straight line when offset is 0, and quadratic curve when offset is non-zero", () => {
  const p1 = { x: 10, y: 20 };
  const p2 = { x: 100, y: 20 };

  const straight = computeLinkCurvePath(p1, p2, 0);
  assert.equal(straight, "M 10 20 L 100 20");

  const curved = computeLinkCurvePath(p1, p2, 16);
  assert.match(curved, /^M 10 20 Q .+ 100 20$/);
  assert.notEqual(curved, straight);
});

test("matchesGraphFilter: filters by industry and publication_year correctly", () => {
  const paper1 = {
    industries: ["IT", "Education"],
    publicationYear: "2024",
  };
  const paper2 = {
    industries: [],
    publicationYear: null,
  };

  // No filter
  assert.equal(matchesGraphFilter(paper1), true);
  assert.equal(matchesGraphFilter(paper2), true);

  // Industry match
  assert.equal(matchesGraphFilter(paper1, "IT"), true);
  assert.equal(matchesGraphFilter(paper1, "Medical"), false);

  // Industry empty sentinel
  assert.equal(matchesGraphFilter(paper1, "__empty__"), false);
  assert.equal(matchesGraphFilter(paper2, "__empty__"), true);

  // Year match
  assert.equal(matchesGraphFilter(paper1, undefined, "2024"), true);
  assert.equal(matchesGraphFilter(paper1, undefined, "2023"), false);

  // Year empty sentinel
  assert.equal(matchesGraphFilter(paper1, undefined, "__empty__"), false);
  assert.equal(matchesGraphFilter(paper2, undefined, "__empty__"), true);

  // Both
  assert.equal(matchesGraphFilter(paper1, "IT", "2024"), true);
  assert.equal(matchesGraphFilter(paper1, "IT", "2023"), false);
});

test("buildGlobalGraphData: builds undirected similarity links cut to k and coauthor links with offsets", () => {
  const papers: GlobalGraphPaperCandidate[] = [
    {
      id: "p1",
      title: "Paper 1",
      authors: ["山田 太郎"],
      similarCandidates: [
        { id: "p2", similarity: 0.9 },
        { id: "p3", similarity: 0.8 },
        { id: "p4", similarity: 0.7 },
      ],
    },
    {
      id: "p2",
      title: "Paper 2",
      authors: ["山田 太郎", "佐藤 花子"],
      similarCandidates: [
        { id: "p1", similarity: 0.9 },
        { id: "p3", similarity: 0.6 },
      ],
    },
    {
      id: "p3",
      title: "Paper 3",
      authors: ["鈴木 一郎"],
      similarCandidates: [],
    },
  ];

  // k=1: p1 has only top 1 similar paper (p2), p2 has p1
  const graphK1 = buildGlobalGraphData(papers, 1);
  assert.equal(graphK1.nodes.length, 3);

  // p1 and p2 have both similarity (0.9) and coauthor (山田 太郎)
  const p1p2Links = graphK1.links.filter(
    (l) =>
      (l.source === "p1" && l.target === "p2") ||
      (l.source === "p2" && l.target === "p1"),
  );
  assert.equal(p1p2Links.length, 2);
  const simLink = p1p2Links.find((l) => l.kind === "similarity");
  const coLink = p1p2Links.find((l) => l.kind === "coauthor");
  assert.equal(simLink?.similarity, 0.9);
  assert.equal(simLink?.curveOffset, 16);
  assert.equal(coLink?.curveOffset, -16);
  assert.deepEqual(coLink?.commonAuthors, ["山田 太郎"]);

  // With k=1, p1-p3 similarity should be excluded (cut to top 1)
  const p1p3Sim = graphK1.links.find(
    (l) =>
      l.kind === "similarity" &&
      ((l.source === "p1" && l.target === "p3") ||
        (l.source === "p3" && l.target === "p1")),
  );
  assert.equal(p1p3Sim, undefined);

  // Now with k=5: p1-p3 similarity (0.8) and p2-p3 similarity (0.6) should be included
  const graphK5 = buildGlobalGraphData(papers, 5);
  const p1p3SimK5 = graphK5.links.find(
    (l) =>
      l.kind === "similarity" &&
      ((l.source === "p1" && l.target === "p3") ||
        (l.source === "p3" && l.target === "p1")),
  );
  assert.ok(p1p3SimK5);
  assert.equal(p1p3SimK5.similarity, 0.8);
  // Single relation -> offset 0
  assert.equal(p1p3SimK5.curveOffset, 0);
});

test("buildGlobalGraphData: handles empty candidates and self-references safely", () => {
  const emptyGraph = buildGlobalGraphData([]);
  assert.deepEqual(emptyGraph, { nodes: [], links: [] });

  const singlePaper: GlobalGraphPaperCandidate[] = [
    {
      id: "solo",
      title: "Solo Paper",
      authors: ["孤独な著者"],
      similarCandidates: [{ id: "solo", similarity: 1.0 }],
    },
  ];
  const singleGraph = buildGlobalGraphData(singlePaper);
  assert.equal(singleGraph.nodes.length, 1);
  assert.equal(singleGraph.links.length, 0);
});

test("buildGlobalGraphData: 上位候補が絞り込みで外れても、絞り込み後の集合の中で k 本がそろう", () => {
  // 全体としてはより類似度が高い論文（global-1, global-2, global-3）が存在するが、
  // 絞り込み条件によってそれらが外れ、絞り込み後の集合（filtered-1 〜 filtered-5）が渡された場合
  const targetPaper: GlobalGraphPaperCandidate = {
    id: "target",
    title: "Target Paper",
    authors: ["研究者A"],
    similarCandidates: [
      { id: "global-out-1", similarity: 0.99 },
      { id: "global-out-2", similarity: 0.98 },
      { id: "global-out-3", similarity: 0.97 },
      { id: "filtered-1", similarity: 0.85 },
      { id: "filtered-2", similarity: 0.84 },
      { id: "filtered-3", similarity: 0.83 },
      { id: "filtered-4", similarity: 0.82 },
      { id: "filtered-5", similarity: 0.81 },
      { id: "filtered-6", similarity: 0.70 },
    ],
  };

  const filteredPapers: GlobalGraphPaperCandidate[] = [
    targetPaper,
    { id: "filtered-1", title: "F1", authors: ["著者1"], similarCandidates: [] },
    { id: "filtered-2", title: "F2", authors: ["著者2"], similarCandidates: [] },
    { id: "filtered-3", title: "F3", authors: ["著者3"], similarCandidates: [] },
    { id: "filtered-4", title: "F4", authors: ["著者4"], similarCandidates: [] },
    { id: "filtered-5", title: "F5", authors: ["著者5"], similarCandidates: [] },
    { id: "filtered-6", title: "F6", authors: ["著者6"], similarCandidates: [] },
  ];

  // k=5 でグラフを構築
  const graph = buildGlobalGraphData(filteredPapers, 5);

  // target につながる類似度リンクを抽出
  const targetSimLinks = graph.links.filter(
    (l) =>
      l.kind === "similarity" &&
      (l.source === "target" || l.target === "target"),
  );

  // 絞り込み外の global-out-* は含まれず、絞り込み後の集合から上位5件（filtered-1 〜 5）が欠落なく揃う
  assert.equal(targetSimLinks.length, 5);
  const connectedIds = targetSimLinks.map((l) =>
    l.source === "target" ? l.target : l.source,
  );
  assert.ok(connectedIds.includes("filtered-1"));
  assert.ok(connectedIds.includes("filtered-2"));
  assert.ok(connectedIds.includes("filtered-3"));
  assert.ok(connectedIds.includes("filtered-4"));
  assert.ok(connectedIds.includes("filtered-5"));
  assert.ok(!connectedIds.includes("filtered-6")); // 6番目は k=5 で切られる
  assert.ok(!connectedIds.includes("global-out-1")); // 外れた論文は入らない
});

test("isSignatureMismatchError: correctly identifies signature mismatch errors", () => {
  assert.equal(isSignatureMismatchError({ code: "PGRST202" }), true);
  assert.equal(isSignatureMismatchError({ code: "PGRST203" }), true);
  assert.equal(isSignatureMismatchError({ code: "42883" }), true);
  assert.equal(
    isSignatureMismatchError({ message: "Could not choose the best candidate function" }),
    true,
  );
  assert.equal(
    isSignatureMismatchError({ message: "function match_related_papers does not exist" }),
    true,
  );
  assert.equal(isSignatureMismatchError({ code: "42P01" }), false);
  assert.equal(isSignatureMismatchError(null), false);
});

test("fetchSimilarCandidatesForPaper: calls RPC with candidateIds, and falls back on signature mismatch", async () => {
  const calls: Array<{ fnName: string; args: Record<string, unknown> }> = [];

  // 1. 正常系: candidateIds が渡され、正しくフィルタリングされる
  const mockCallerNormal: RpcCaller = {
    async rpc(fnName, args) {
      calls.push({ fnName, args });
      return {
        data: [
          { id: "p2", similarity: 0.88 },
          { id: "p3", similarity: 0.75 },
          { id: "p-other", similarity: 0.95 }, // filteredIdSet にない
        ],
        error: null,
      };
    },
  };

  const res1 = await fetchSimilarCandidatesForPaper(
    mockCallerNormal,
    "p1",
    5,
    ["p2", "p3"],
    new Set(["p1", "p2", "p3"]),
  );

  assert.equal(res1.hasError, false);
  assert.equal(res1.candidates.length, 2);
  assert.equal(res1.candidates[0].id, "p2");
  assert.equal(res1.candidates[1].id, "p3");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.p_candidate_ids, ["p2", "p3"]);

  // 2. シグネチャ不一致エラー時: フォールバック（p_candidate_ids なし）が走る
  const fallbackCalls: Array<{ fnName: string; args: Record<string, unknown> }> = [];
  const mockCallerMismatch: RpcCaller = {
    async rpc(fnName, args) {
      fallbackCalls.push({ fnName, args });
      if (args.p_candidate_ids) {
        return {
          data: null,
          error: { code: "PGRST202", message: "function match_related_papers does not exist" },
        };
      }
      return {
        data: [{ id: "p2", similarity: 0.88 }],
        error: null,
      };
    },
  };

  const res2 = await fetchSimilarCandidatesForPaper(
    mockCallerMismatch,
    "p1",
    5,
    ["p2"],
    new Set(["p1", "p2"]),
  );

  assert.equal(res2.hasError, false);
  assert.equal(res2.candidates.length, 1);
  assert.equal(res2.candidates[0].id, "p2");
  assert.equal(fallbackCalls.length, 2);
  assert.equal(fallbackCalls[1].args.p_candidate_ids, undefined);

  // 3. 一般エラー時: フォールバックせず hasError: true を返す
  const mockCallerError: RpcCaller = {
    async rpc() {
      return { data: null, error: { code: "50000", message: "Database timeout" } };
    },
  };

  const res3 = await fetchSimilarCandidatesForPaper(
    mockCallerError,
    "p1",
    5,
    ["p2"],
    new Set(["p1", "p2"]),
  );
  assert.equal(res3.hasError, true);
  assert.equal(res3.candidates.length, 0);
});
