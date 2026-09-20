import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDescriptionFromParsedPaste,
  looksLikeMisparsedAuthors,
  parsePaperMetadataPaste,
} from "./paper-metadata-paste.ts";

test("既存フォーマット（Title: / DOI / 著者 / 年-掲載）は従来どおり解析できる", () => {
  const raw = [
    "Title: Some Real Title, With Comma",
    "10.1234/example.2021",
    "Jane Doe, John Smith and Co.",
    "2021-Journal of Testing",
  ].join("\n");
  const p = parsePaperMetadataPaste(raw);
  assert.equal(p.title, "Some Real Title, With Comma");
  assert.equal(p.doi, "10.1234/example.2021");
  assert.equal(p.authors, "Jane Doe, John Smith and Co.");
  assert.equal(p.publicationYear, "2021");
  assert.equal(p.venue, "Journal of Testing");
  assert.equal(p.venueUncertain, false);
  assert.equal(p.authorsTruncated, false);
});

test("scispace形式1: 年⋅著者(中点連結) + 分野タグ行 でタイトル/著者が入れ替わらない", () => {
  const raw = [
    "Relating Doubly-Even Error-Correcting Codes, Graphs, and Irreducible Representations of N-Extended Supersymmetry",
    "2008\u22c5C.F. Doran, M.G. Faux, S.J. Gates Jr., T. Hubsch, K.M. Iga, G.D. LandweberShow Less",
    "Discrete and Computational Mathematics",
  ].join("\n");
  const p = parsePaperMetadataPaste(raw);
  assert.equal(
    p.title,
    "Relating Doubly-Even Error-Correcting Codes, Graphs, and Irreducible Representations of N-Extended Supersymmetry",
  );
  assert.equal(p.publicationYear, "2008");
  assert.equal(
    p.authors,
    "C.F. Doran, M.G. Faux, S.J. Gates Jr., T. Hubsch, K.M. Iga, G.D. Landweber",
  );
  assert.equal(p.doi, "");
  assert.equal(p.venue, "Discrete and Computational Mathematics");
  assert.equal(p.venueUncertain, true);
  assert.equal(p.authorsTruncated, false);
});

test("scispace形式2: 年⋅DOI⋅著者(省略あり) + 掲載誌 でタイトル/著者/年/掲載誌を正しく取れる", () => {
  const raw = [
    "Design and application of intelligent monitoring system for road and bridge based on Internet of Things technology",
    "2026\u22c5DOI\u22c5Yingfei Yang, Huayu Zhao...+3 More",
    "AIP Advances",
  ].join("\n");
  const p = parsePaperMetadataPaste(raw);
  assert.equal(
    p.title,
    "Design and application of intelligent monitoring system for road and bridge based on Internet of Things technology",
  );
  assert.equal(p.publicationYear, "2026");
  assert.equal(p.authors, "Yingfei Yang, Huayu Zhao");
  assert.equal(p.authorsTruncated, true);
  assert.equal(p.truncatedAuthorsCount, 3);
  assert.equal(p.doi, "");
  assert.equal(p.venue, "AIP Advances");
  assert.equal(p.venueUncertain, true);
});

test("looksLikeMisparsedAuthors: 誤って混入した長い文章を検出する", () => {
  assert.equal(
    looksLikeMisparsedAuthors([
      "Design and application of intelligent monitoring system for road and bridge based on Internet of Things technology",
    ]),
    true,
  );
  assert.equal(looksLikeMisparsedAuthors(["Jane Doe", "John Smith"]), false);
  assert.equal(looksLikeMisparsedAuthors(["Jane Doe"]), false);
});

test("buildDescriptionFromParsedPaste: 未確認掲載欄と省略著者の注記が入る", () => {
  const p = parsePaperMetadataPaste(
    [
      "Design and application of intelligent monitoring system for road and bridge based on Internet of Things technology",
      "2026\u22c5DOI\u22c5Yingfei Yang, Huayu Zhao...+3 More",
      "AIP Advances",
    ].join("\n"),
  );
  const desc = buildDescriptionFromParsedPaste(p);
  assert.match(desc, /掲載\/分野（未確認）: AIP Advances/);
  assert.match(desc, /著者: Yingfei Yang, Huayu Zhao ほか3名（貼り付け元で省略）/);
});

test("scispace Files カードのナビ込みコピーでもタイトルはファイル名にならない", () => {
  const raw = [
    "2312.01865v1.pdf",
    "Home",
    "A comprehensive survey of Schwarzschild's original papers: Schwarzschild's trick and Einstein's s(h)tick",
    "2023\u22c5Galina Weinstein",
    "arXiv",
    "This paper examines Schwarzschild's contributions to general relativity, focusing on his methods for developing exact solutions.",
  ].join("\n");
  const p = parsePaperMetadataPaste(raw);
  assert.match(p.title, /comprehensive survey of Schwarzschild/);
  assert.equal(p.publicationYear, "2023");
  assert.equal(p.authors, "Galina Weinstein");
  assert.equal(p.venue, "arXiv");
  assert.equal(p.venueUncertain, true);
});

test("Files 行の TL;DR 本文はタイトルや掲載にしない", () => {
  const raw = [
    "42c1add0da9312ee.pdf",
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
    "The paper discusses the concept of multiverses, particularly focusing on the Level IV multiverse, which encompasses all possible mathematical structures. It explores the implications of different initial conditions and the potential for parallel universes, emphasizing the challenges in testing these theories.",
  ].join("\n");
  const p = parsePaperMetadataPaste(raw);
  assert.equal(p.title, "");
  assert.doesNotMatch(p.title, /multiverses/);
  assert.doesNotMatch(p.venue, /multiverses/);
  assert.doesNotMatch(p.authors, /multiverses/);
});

test("ワークショップ掲載の3行メタはタイトル・年・著者・掲載に分解する", () => {
  const raw = [
    "EVALUATING PERFORMANCE DRIFT FROM MODEL SWITCHING IN MULTI-TURN LLM SYSTEMS",
    "2026\u22c5Raad Khraishi, Iman Zafar...+2 More",
    "ICLR 2026 CAO Workshop",
  ].join("\n");
  const p = parsePaperMetadataPaste(raw);
  assert.equal(
    p.title,
    "EVALUATING PERFORMANCE DRIFT FROM MODEL SWITCHING IN MULTI-TURN LLM SYSTEMS",
  );
  assert.equal(p.publicationYear, "2026");
  assert.equal(p.authors, "Raad Khraishi, Iman Zafar");
  assert.equal(p.authorsTruncated, true);
  assert.equal(p.truncatedAuthorsCount, 2);
  assert.equal(p.venue, "ICLR 2026 CAO Workshop");
  assert.doesNotMatch(p.title, /switch-matrix/);
});
