import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containsForeignPdf,
  doiFromHrefOrText,
  extractSciSpaceCardMeta,
  isolateSciSpaceCardText,
  pickBestSciSpaceCardText,
  sciSpaceExtractionLooksLikeChrome,
  titleLooksLikeFilename,
  looksLikeCitationTitle,
  looksLikeSciSpaceNav,
  tldrUsable,
  descriptionUsable,
  pickAbstractSection,
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

const lineweaverCard = [
  "LineweaverPatel2023final.pdf",
  "All objects and some questions",
  "2023\u22c5DOI\u22c5Charles H. Lineweaver, Vihan M. Patel",
  "American Journal of Physics",
  "PDF UPLOAD",
  "Uploaded on 19 Sep 2026",
  "The paper explores the thermal history of the Universe, detailing how various objects formed as it expanded and cooled. It discusses the relationship between gravity and quantum mechanics, particularly in the context of Planck-mass black holes and the concept of the Universe potentially being a black hole itself.",
].join("\n");

test("extractSciSpaceCardMeta: Files 右列の TL;DR と年·DOI·著者を取る", () => {
  const m = extractSciSpaceCardMeta(lineweaverCard, "LineweaverPatel2023final.pdf");
  assert.equal(m.title, "All objects and some questions");
  assert.equal(m.publicationYear, "2023");
  assert.equal(m.authors, "Charles H. Lineweaver, Vihan M. Patel");
  assert.equal(m.venue, "American Journal of Physics");
  assert.match(m.tldr, /thermal history of the Universe/);
  assert.equal(m.doi, "");
});

test("Files 左列の PDF UPLOAD 行は TL;DR ではない", () => {
  const left = "All objects and some questions 2023⋅DOI⋅Charles H. Lineweaver, Vihan M. Patel American Journal of Physics PDF UPLOAD Uploaded on 19 Sep.";
  assert.equal(looksLikeSciSpaceNav(left), true);
  assert.equal(descriptionUsable(left), false);
  assert.equal(tldrUsable(left), false);
});

test("Files 一覧の TL;DR 列（The paper / This paper）を取る", () => {
  const popper = [
    "Popper-Conjectures-Rwefutations-GrowthOfKnowledge.pdf",
    "CONJECTURES AND REFUTATIONS The Growth of Scientific Knowledge",
    "1962 · Karl R. Popper",
    "PDF UPLOAD",
    "Uploaded on 19 Sep 2026",
    "The paper discusses the importance of learning from mistakes in the pursuit of knowledge, emphasizing that criticism and tentative solutions are essential for scientific progress. It argues that while knowledge can never be positively justified, it can grow through the process of identifying and correcting errors 1.",
  ].join("\n");
  const p = extractSciSpaceCardMeta(popper, "Popper-Conjectures-Rwefutations-GrowthOfKnowledge.pdf");
  assert.match(p.tldr, /learning from mistakes/);
  assert.doesNotMatch(p.tldr, /\s1\.?$/);

  const schwarz = [
    "0709.2257v2.pdf",
    "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    "2007 · Lluís Bel",
    "arXiv",
    "This paper discusses the complexities of Schwarzschild's solution to Einstein's field equations, emphasizing its pedagogical purpose and the need for clarity in understanding the gravitational field of a point particle. It aims to present a simpler and more aesthetically pleasing form of the solution while remaining true to Schwarzschild's original intent 1 2.",
  ].join("\n");
  const s = extractSciSpaceCardMeta(schwarz, "0709.2257v2.pdf");
  assert.match(s.tldr, /complexities of Schwarzschild/);
  assert.doesNotMatch(s.tldr, /\s1\s+2\.?$/);
});

test("doiFromHrefOrText: doi.org リンクから DOI を取る", () => {
  assert.equal(doiFromHrefOrText("https://doi.org/10.1119/5.0150209"), "10.1119/5.0150209");
  assert.equal(doiFromHrefOrText("2023 · DOI · Charles H. Lineweaver"), "");
});

test("isolateSciSpaceCardText: 検索欄の stem だけでは隣カードを自分の論文にしない", () => {
  const searchThenNeighbor = [
    "819_1_5.0150209",
    "All objects and some questions",
    "2023\u22c5DOI\u22c5Charles H. Lineweaver, Vihan M. Patel",
    "LineweaverPatel2023final.pdf",
    "All objects and some questions",
  ].join("\n");
  const isolated = isolateSciSpaceCardText(searchThenNeighbor, "819_1_5.0150209.pdf");
  assert.equal(isolated, "");
});

test("pickBestSciSpaceCardText: ファイル名だけのセルより TL;DR 付きカードを選ぶ", () => {
  const filenameOnly = "LineweaverPatel2023final.pdf";
  const picked = pickBestSciSpaceCardText(
    [filenameOnly, lineweaverCard],
    "LineweaverPatel2023final.pdf",
  );
  const m = extractSciSpaceCardMeta(picked, "LineweaverPatel2023final.pdf");
  assert.match(m.tldr, /thermal history of the Universe/);
  assert.equal(m.title, "All objects and some questions");
});

test("SciSpace 個別ページの Explain math はタイトルにしない", () => {
  const chrome = [
    "Explain math & table",
    "Generate summary of this paper, Results of the paper, Conclusions from the paper",
    "0709.2257v2.pdf",
  ].join("\n");
  const m = extractSciSpaceCardMeta(chrome, "0709.2257v2.pdf");
  assert.notEqual(m.title, "Explain math & table");
  assert.equal(m.tldr.includes("Generate summary of this paper"), false);
});

test("個別ページの og:description 相当は TL;DR にできる", () => {
  const raw = [
    "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    "This paper derives the gravitational field of a mass point according to Einstein's theory and discusses the resulting metric.",
  ].join("\n");
  const m = extractSciSpaceCardMeta(raw, "0709.2257v2.pdf");
  assert.match(m.title, /Gravitationsfeld/);
  assert.match(m.tldr, /gravitational field of a mass point/);
});

test("arXiv:ID 行は論文タイトル扱いしない", () => {
  assert.equal(
    titleLooksLikeFilename("arXiv:0709.2257v2 [gr-qc] 29 Sep 2007", "0709.2257v2.pdf"),
    true,
  );
  const m = extractSciSpaceCardMeta(
    "arXiv:0709.2257v2 [gr-qc] 29 Sep 2007\nÜber das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    "0709.2257v2.pdf",
  );
  assert.match(m.title, /Gravitationsfeld/);
});

test("空の TL;DR は画面の文言ではない", () => {
  assert.equal(sciSpaceExtractionLooksLikeChrome("Explain math & table", ""), true);
  assert.equal(
    sciSpaceExtractionLooksLikeChrome(
      "Particle Creation by Black Holes",
      "",
    ),
    false,
  );
  assert.equal(
    sciSpaceExtractionLooksLikeChrome(
      "Particle Creation by Black Holes",
      "Generate summary of this paper, Results of the paper",
    ),
    true,
  );
});

test("引用行や unit volume 断片はタイトル・掲載にしない", () => {
  const raw = [
    "Commun. math. Phys. 43, 199—220 (1975)",
    "Particle Creation by Black Holes",
    "modes per unit volume in the frequency interval",
    "inside the black hole where the Killing vector which represents time translations and has a much longer body fragment without being an abstract",
  ].join("\n");
  const m = extractSciSpaceCardMeta(raw, "1103899181.pdf");
  assert.equal(m.title, "Particle Creation by Black Holes");
  assert.notEqual(m.venue, "modes per unit volume in the frequency interval");
  assert.equal(m.tldr.startsWith("inside the black hole"), false);
});

test("誌名だけの行は論文タイトルにしない", () => {
  const raw = [
    "Publications of the Astronomical Society of Australia",
    "Galaxy spin direction asymmetry in JWST deep fields",
  ].join("\n");
  const m = extractSciSpaceCardMeta(raw, "2403.17271v1.pdf");
  assert.match(m.title, /Galaxy spin direction/);
});

test("日付・ページ範囲・PDF全画面はタイトルにしない", () => {
  assert.equal(looksLikeCitationTitle("OCTOBER 01 2023"), true);
  assert.equal(looksLikeCitationTitle(", 1–20 (2025)"), true);
  assert.equal(looksLikeCitationTitle("Read PDF in full screen"), true);
  assert.equal(looksLikeCitationTitle("© by Springer-Verlag 1975"), true);
  assert.equal(looksLikeCitationTitle("All objects and some questions"), false);
});

test("途中切れの TL;DR は使わない", () => {
  assert.equal(
    tldrUsable("This paper highlights the interplay between Karl Schwarzschild’s mathematical inge-"),
    false,
  );
  assert.equal(
    tldrUsable("We present an overview of the thermal history of the Universe and the sequence of objects (e.g.,."),
    false,
  );
  assert.equal(
    tldrUsable(
      "Schwarzschild's solution of Einstein's field equations in vacuum can be written in many different forms. Unfortunately Schwarzschild's own original form is less nice looking.",
    ),
    true,
  );
});

test("Abstract 見出しの段落を TL;DR にする", () => {
  const raw = [
    "Abstract",
    "Schwarzschild's solution of Einstein's field equations in vacuum can be written in many different forms. We prove here that we can have both a nice looking simple form and the meaning that Schwarzschild wanted.",
    "1. Introduction",
  ].join("\n");
  assert.match(pickAbstractSection(raw), /Schwarzschild's solution of Einstein's field equations/);
});

test("長い日本語要約は画面文言ではなく説明に使える", () => {
  const s = [
    "この資料は、カール・R・ポパーによる著書『推測と反駁：科学的知識の成長』の序文と導入部分からの抜粋です。",
    "",
    "### 主な研究手法",
    "推測と反駁を通じて科学的知識が成長するという立場を、具体例を交えて整理している。",
  ].join("\n");
  assert.equal(looksLikeSciSpaceNav(s), false);
  assert.equal(descriptionUsable(s), true);
});

test("SciSpace のプロンプト列は長くても説明にしない", () => {
  const s =
    "Generate summary of this paper, Results of the paper, Conclusions from the paper, Explain Abstract of this paper, What are the contributions of this paper, Find Related Papers, Explain the practical implications of this paper, Summarise introduction of this paper, Literature survey of this paper, Methods used in this paper, What data has been used in this paper, Limitations of this paper, Future works suggested in this paper.";
  assert.equal(looksLikeSciSpaceNav(s), true);
  assert.equal(descriptionUsable(s), false);
  assert.equal(tldrUsable(s), false);
});
