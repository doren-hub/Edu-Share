import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containsForeignPdf,
  extractSciSpaceCardMeta,
  isolateSciSpaceCardText,
} from "./scispace-card.ts";

const noisy = [
  "Home",
  "Agent Gallery",
  "Templates",
  "2312.01865v1.pdf",
  "A comprehensive survey of Schwarzschild's original papers: Schwarzschild's trick and Einstein's s(h)tick",
  "2023\u22c5Galina Weinstein",
  "arXiv",
  "PDF UPLOAD",
  "Uploaded on 18 Sep 2026",
  "This paper examines Schwarzschild's contributions to general relativity, focusing on his methods for developing exact solutions. It highlights the collaborative exchange between Schwarzschild and Einstein, revealing that Einstein's preference for approximate solutions in 1916 was influenced by factors beyond singularity concerns 1.",
  "Column Settings",
].join("\n");

test("extractSciSpaceCardMeta: ナビ付きコピーからタイトル・年著者・arXiv・TL;DR を取る", () => {
  const m = extractSciSpaceCardMeta(noisy, "2312.01865v1.pdf");
  assert.match(m.title, /comprehensive survey of Schwarzschild/);
  assert.equal(m.publicationYear, "2023");
  assert.equal(m.authors, "Galina Weinstein");
  assert.equal(m.venue, "arXiv");
  assert.match(m.tldr, /This paper examines Schwarzschild's contributions/);
  assert.match(m.tldr, /beyond singularity concerns\.$/);
  assert.doesNotMatch(m.tldr, /\s\d+\.?$/);
  assert.equal(
    m.paste,
    [
      "A comprehensive survey of Schwarzschild's original papers: Schwarzschild's trick and Einstein's s(h)tick",
      "2023\u22c5Galina Weinstein",
      "arXiv",
    ].join("\n"),
  );
});

const mixedFiles = [
  "Home",
  "Files (5)",
  "1103899181.pdf",
  "PDF UPLOAD",
  "Uploaded on 18 Sep 2026",
  "The paper discusses how quantum mechanical effects allow black holes to emit particles, leading to a gradual decrease in their mass and eventual evaporation.",
  "2312.01865v1.pdf",
  "A comprehensive survey of Schwarzschild's original papers: Schwarzschild's trick and Einstein's s(h)tick",
  "2023\u22c5Galina Weinstein",
  "arXiv",
  "This paper examines Schwarzschild's contributions to general relativity, focusing on his methods for developing exact solutions.",
  "hawking.pdf",
  "BLACK HOLES AREN'T BLACK",
  "1974\u22c5S. W. Hawking",
].join("\n");

test("isolateSciSpaceCardText: 次の PDF 行で切って隣のカードを混ぜない", () => {
  const card = isolateSciSpaceCardText(mixedFiles, "1103899181.pdf");
  assert.match(card, /1103899181\.pdf/);
  assert.doesNotMatch(card, /2312\.01865v1/);
  assert.doesNotMatch(card, /Schwarzschild/);
  assert.doesNotMatch(card, /hawking\.pdf/);
});

test("extractSciSpaceCardMeta: 一覧の隣カードのタイトルを自分の論文にしない", () => {
  const m = extractSciSpaceCardMeta(mixedFiles, "1103899181.pdf");
  assert.doesNotMatch(m.title, /Schwarzschild/);
  assert.equal(m.authors, "");
  assert.equal(m.publicationYear, "");
  assert.equal(m.venue, "");
  assert.match(m.tldr, /quantum mechanical effects/);
  assert.equal(containsForeignPdf(mixedFiles, "1103899181.pdf"), true);
});

test("extractSciSpaceCardMeta: 混在コピーでも指定ファイルのカードは取れる", () => {
  const m = extractSciSpaceCardMeta(mixedFiles, "2312.01865v1.pdf");
  assert.match(m.title, /comprehensive survey of Schwarzschild/);
  assert.equal(m.authors, "Galina Weinstein");
  assert.doesNotMatch(m.title, /BLACK HOLES/);
});
