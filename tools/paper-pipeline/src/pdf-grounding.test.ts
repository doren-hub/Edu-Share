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

test("extractSignificantWords: 日本語テキストから bigram を抽出する", () => {
  const words = extractSignificantWords("教育支援システム");
  assert.ok(words.includes("教育"));
  assert.ok(words.includes("育支"));
  assert.ok(words.includes("支援"));
  assert.ok(words.includes("援シ"));
});

test("isTitleGroundedInPdfText: 日本語の論文題名が本文先頭にあれば採用する", () => {
  const samplePdf = `
大規模言語モデルを用いた教育支援システムの有効性検証
山田太郎, 佐藤花子
東京大学

概要
本研究では、大規模言語モデルを活用した教育支援システムの構築を行い、
実際のプログラミング講義における学習効果と課題について分析を行った。
受講生の質問履歴およびコード修正ログを解析した結果、自律的な学習支援において
有意な改善傾向が確認された。
`.trim();

  // 完全一致
  assert.equal(isTitleGroundedInPdfText("大規模言語モデルを用いた教育支援システムの有効性検証", samplePdf), true);
  // 部分一致
  assert.equal(isTitleGroundedInPdfText("大規模言語モデルを用いた教育支援システム", samplePdf), true);
  // 別の日本語題名（弾かれる）
  assert.equal(isTitleGroundedInPdfText("古代ローマ建築におけるコンクリート構造の力学的特性", samplePdf), false);
});

test("isDescriptionGroundedInPdfText: 日本語の説明が本文と合致すれば採用し、異なれば弾く", () => {
  const samplePdf = `
大規模言語モデルを用いた教育支援システムの有効性検証
山田太郎, 佐藤花子
東京大学

概要
本研究では、大規模言語モデルを活用した教育支援システムの構築を行い、
実際のプログラミング講義における学習効果と課題について分析を行った。
受講生の質問履歴およびコード修正ログを解析した結果、自律的な学習支援において
有意な改善傾向が確認された。
`.trim();

  // 本文と合致する説明
  const matchingDesc = "本研究では、大規模言語モデルを活用した教育支援システムを構築し、プログラミング講義における学習効果を検証した。";
  assert.equal(isDescriptionGroundedInPdfText(matchingDesc, samplePdf), true);

  // まったく別の日本語論文の要約
  const foreignDesc = "本研究では、江戸時代中期の幕府勘定所における出納記録を史料批判し、年貢収納の実態を明らかにする。";
  assert.equal(isDescriptionGroundedInPdfText(foreignDesc, samplePdf), false);
});

