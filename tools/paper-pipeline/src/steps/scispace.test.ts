import test from "node:test";
import assert from "node:assert/strict";
import { applyExtractedCard } from "./scispace.ts";
import { emptyState } from "../state.ts";

test("applyExtractedCard: Not addressed in the paper. は題名・説明に採用せずファイル名にフォールバックする", () => {
  const state = emptyState({ filename: "quantum_paper.pdf", inboxPdfPath: "/tmp/quantum_paper.pdf", paperDir: "/tmp" });
  const card = {
    title: "Not addressed in the paper.",
    yearAuthorLine: "2023 · Not specified",
    authors: "Not specified",
    publicationYear: "2023",
    venue: "",
    doi: "",
    paste: "",
    tldr: "The paper does not mention any conclusions.",
  };

  applyExtractedCard(state, "quantum_paper.pdf", card);
  assert.equal(state.title, "quantum_paper");
  assert.equal(state.tldr, "");
});

test("applyExtractedCard: スキャンの PDF では題名・説明を採用しない", () => {
  const state = emptyState({ filename: "scanned_doc.pdf", inboxPdfPath: "/tmp/scanned_doc.pdf", paperDir: "/tmp" });
  const card = {
    title: "Deep Residual Learning for Image Recognition",
    yearAuthorLine: "2016 · Kaiming He",
    authors: "Kaiming He",
    publicationYear: "2016",
    venue: "CVPR",
    doi: "10.1109/CVPR.2016.90",
    paste: "",
    tldr: "This paper presents a residual learning framework to ease the training of substantially deeper neural networks.",
  };

  const scannedPdfText = "Page 1 [image only]";
  applyExtractedCard(state, "scanned_doc.pdf", card, [], scannedPdfText);

  // スキャン PDF では SciSpace の題名と説明を採用せず、題名はファイル名、説明は空
  assert.equal(state.title, "scanned_doc");
  assert.equal(state.tldr, "");
});

test("applyExtractedCard: 本文と合う題名と説明は採用する", () => {
  const state = emptyState({ filename: "resnet.pdf", inboxPdfPath: "/tmp/resnet.pdf", paperDir: "/tmp" });
  const card = {
    title: "Deep Residual Learning for Image Recognition",
    yearAuthorLine: "2016 · Kaiming He",
    authors: "Kaiming He",
    publicationYear: "2016",
    venue: "CVPR",
    doi: "10.1109/CVPR.2016.90",
    paste: "",
    tldr: "This paper presents a residual learning framework to ease the training of networks that are substantially deeper than those previously used.",
  };

  const pdfText = `
Deep Residual Learning for Image Recognition
Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun
Microsoft Research

Abstract
Deeper neural networks are more difficult to train. We present a residual learning
framework to ease the training of networks that are substantially deeper than those
previously used. We explicitly reformulate the layers as learning residual functions
with reference to the layer inputs, instead of learning unreferenced functions.
We evaluate these residual networks on the ImageNet dataset with a depth of up to 152 layers.
`.trim();

  applyExtractedCard(state, "resnet.pdf", card, [], pdfText);

  assert.equal(state.title, "Deep Residual Learning for Image Recognition");
  assert.equal(state.sciTitleRejected, false);
  assert.match(state.tldr, /residual learning framework/);
});

test("applyExtractedCard: 本文と合わない題名や別の論文の説明は採用しない", () => {
  const state = emptyState({ filename: "resnet.pdf", inboxPdfPath: "/tmp/resnet.pdf", paperDir: "/tmp" });
  const card = {
    title: "Efficacy of mRNA Vaccines in Oncology Patients",
    yearAuthorLine: "2021 · John Doe",
    authors: "John Doe",
    publicationYear: "2021",
    venue: "Nature Medicine",
    doi: "",
    paste: "",
    tldr: "This paper evaluates the clinical efficacy and adverse reactions of mRNA vaccines in pediatric leukemia patients undergoing chemotherapy.",
  };

  const resnetPdfText = `
Deep Residual Learning for Image Recognition
Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun
Microsoft Research

Abstract
Deeper neural networks are more difficult to train. We present a residual learning
framework to ease the training of networks that are substantially deeper than those
previously used. We explicitly reformulate the layers as learning residual functions
with reference to the layer inputs.
`.trim();

  applyExtractedCard(state, "resnet.pdf", card, [], resnetPdfText);

  // 本文と合わない題名はファイル名に、合わない説明は空に
  assert.equal(state.title, "resnet");
  assert.equal(state.sciTitleRejected, true);
  assert.equal(state.tldr, "");
});

