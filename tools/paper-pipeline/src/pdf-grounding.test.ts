import test from "node:test";
import assert from "node:assert/strict";
import {
  isScannedPdfText,
  isTitleGroundedInPdfText,
  isDescriptionGroundedInPdfText,
  extractSignificantWords,
  MIN_PDF_TEXT_CHARS,
} from "./pdf-grounding.ts";

test("isScannedPdfText: 空または短いテキストはスキャン（テキストなし）と判定する", () => {
  assert.equal(isScannedPdfText(""), true);
  assert.equal(isScannedPdfText("   \n\t  "), true);
  assert.equal(isScannedPdfText("Page 1 of 12\nConfidential"), true);
  assert.equal(isScannedPdfText("a".repeat(MIN_PDF_TEXT_CHARS - 1)), true);

  // 十分な文字数があれば false
  assert.equal(isScannedPdfText("a".repeat(MIN_PDF_TEXT_CHARS)), false);
});

test("isTitleGroundedInPdfText: スキャン PDF では題名を採用しない", () => {
  const scanned = "Scanned PDF page 1 header";
  assert.equal(isTitleGroundedInPdfText("Deep Residual Learning for Image Recognition", scanned), false);
  assert.equal(isTitleGroundedInPdfText("Attention Is All You Need", ""), false);
});

test("isTitleGroundedInPdfText: 本文の先頭部分に題名の単語が含まれていれば採用する", () => {
  const samplePdf = `
Deep Residual Learning for Image Recognition
Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun
Microsoft Research

Abstract
Deeper neural networks are more difficult to train. We present a residual learning
framework to ease the training of networks that are substantially deeper than those
previously used. We explicitly reformulate the layers as learning residual functions
with reference to the layer inputs, instead of learning unreferenced functions.
`.trim();

  // 完全一致または先頭に含まれる
  assert.equal(isTitleGroundedInPdfText("Deep Residual Learning for Image Recognition", samplePdf), true);

  // 大文字小文字や改行の差異があっても主要単語が含まれていれば採用
  assert.equal(isTitleGroundedInPdfText("deep residual learning for image recognition", samplePdf), true);
  assert.equal(isTitleGroundedInPdfText("Deep Residual Learning", samplePdf), true);
});

test("isTitleGroundedInPdfText: 本文の先頭と合わない題名は採用しない", () => {
  const samplePdf = `
Deep Residual Learning for Image Recognition
Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun
Microsoft Research

Abstract
Deeper neural networks are more difficult to train...
`.trim();

  // まったく別の題名
  assert.equal(isTitleGroundedInPdfText("Quantum Teleportation Across the Danube", samplePdf), false);
  assert.equal(isTitleGroundedInPdfText("Skip to Main Content", samplePdf), false);
  assert.equal(isTitleGroundedInPdfText("Not addressed in the paper.", samplePdf), false);
});

test("isDescriptionGroundedInPdfText: スキャン PDF では説明を採用しない", () => {
  const scanned = "Only a few header words on scanned page";
  const desc = "This paper presents a novel approach to deep residual networks for object detection.";
  assert.equal(isDescriptionGroundedInPdfText(desc, scanned), false);
  assert.equal(isDescriptionGroundedInPdfText(desc, ""), false);
});

test("isDescriptionGroundedInPdfText: 本文と単語が重なる説明は採用する", () => {
  const samplePdf = `
Deep Residual Learning for Image Recognition
Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun
Microsoft Research

Abstract
Deeper neural networks are more difficult to train. We present a residual learning
framework to ease the training of networks that are substantially deeper than those
previously used. We explicitly reformulate the layers as learning residual functions
with reference to the layer inputs. We evaluate these residual networks on ImageNet
and CIFAR-10 benchmarks.
`.trim();

  const matchingDesc = "This paper presents a residual learning framework to ease the training of deeper neural networks on ImageNet.";
  assert.equal(isDescriptionGroundedInPdfText(matchingDesc, samplePdf), true);
});

test("isDescriptionGroundedInPdfText: 別の論文の要約など本文と重ならない説明は採用しない", () => {
  const samplePdf = `
Deep Residual Learning for Image Recognition
Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun
Microsoft Research

Abstract
Deeper neural networks are more difficult to train. We present a residual learning
framework to ease the training of networks that are substantially deeper than those
previously used.
`.trim();

  // 医療論文の要約（Deep Residual Learning には全く出現しない）
  const foreignDesc = "This paper investigates mRNA vaccine immunogenicity and adverse events in pediatric oncology patients with acute lymphoblastic leukemia.";
  assert.equal(isDescriptionGroundedInPdfText(foreignDesc, samplePdf), false);
});

test("extractSignificantWords: ストップワードと記号を除き、小文字・ユニークにする", () => {
  const words = extractSignificantWords("The quick, brown Fox jumps over the lazy Dog! And a paper study.");
  assert.deepEqual(words, ["quick", "brown", "fox", "jumps", "lazy", "dog"]);
});
