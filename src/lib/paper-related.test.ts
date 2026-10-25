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
  type RelatedPapersResponse,
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
