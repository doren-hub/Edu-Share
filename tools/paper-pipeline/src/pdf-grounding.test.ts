import test from "node:test";
import assert from "node:assert/strict";
import {
  isScannedPdfText,
  isTitleGroundedInPdfText,
  isDescriptionGroundedInPdfText,
  isDoiGroundedInPdfText,
  findReferencesSectionIndex,
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

test("issue 337: isDoiGroundedInPdfText は DOI が PDF 本文に含まれているかを照合する", () => {
  const samplePdf = `
Global Burden of Disease Study 2015
Christopher J L Murray et al.
The Lancet, Vol. 388, No. 10053, p1659-1724
DOI: https://doi.org/10.1016/S0140-6736(16)32380-7
Abstract
We conducted a comprehensive assessment of all-cause mortality across 195 countries and territories from 1980 to 2015.
`.trim();

  // 本文に含まれる DOI（かっこ含む完全なもの）
  assert.equal(isDoiGroundedInPdfText("10.1016/S0140-6736(16)32380-7", samplePdf), true);
  // 大文字小文字の差異
  assert.equal(isDoiGroundedInPdfText("10.1016/s0140-6736(16)32380-7", samplePdf), true);
  // 本文に含まれない別の DOI
  assert.equal(isDoiGroundedInPdfText("10.1038/nature12345", samplePdf), false);
  // スキャン PDF
  assert.equal(isDoiGroundedInPdfText("10.1016/S0140-6736(16)32380-7", "Page 1"), false);
  // 空文字
  assert.equal(isDoiGroundedInPdfText("", samplePdf), false);
  assert.equal(isDoiGroundedInPdfText("10.1016/S0140-6736(16)32380-7", undefined), false);
});

test("issue 337: isDoiGroundedInPdfText は DOI の前方部分一致（より長い別 DOI の接頭辞）を除外する", () => {
  const pdfWithLongerDoi = `
Research Paper Title
Author Name
DOI: 10.1000/abc12
More detailed text for PDF length requirements.
${"Testing prefix grounding boundary logic for issue 337. ".repeat(4)}
`.trim();

  // 10.1000/abc1 は 10.1000/abc12 の接頭辞にすぎないため不一致とする
  assert.equal(isDoiGroundedInPdfText("10.1000/abc1", pdfWithLongerDoi), false);

  const pdfWithExactDoi = `
Research Paper Title
Author Name
DOI: 10.1000/abc1.
Sentence follows with text for length requirement.
${"Testing prefix grounding boundary logic for issue 337. ".repeat(4)}
`.trim();

  // 末尾がピリオド（文末）や空白の場合は完全一致として一致する
  assert.equal(isDoiGroundedInPdfText("10.1000/abc1", pdfWithExactDoi), true);
});

test("issue 339: findReferencesSectionIndex は参考文献の見出し位置を検出する", () => {
  assert.equal(findReferencesSectionIndex("Simple text without references"), -1);
  assert.equal(findReferencesSectionIndex("Title\nReferences\n[1] Paper"), 6);
  assert.equal(findReferencesSectionIndex("Title\n8. References\n[1] Paper"), 6);
  assert.equal(findReferencesSectionIndex("Title\n【参考文献】\n[1] 論文"), 6);
  assert.equal(findReferencesSectionIndex("Title\n引用文献\n[1] 論文"), 6);
  // 本文中の言及（見出しではない行）は検出しない
  assert.equal(findReferencesSectionIndex("Title\nWith reference to previous work\nText"), -1);
});

test("issue 339: isDoiGroundedInPdfText は参考文献の一覧にだけある DOI を採用しない", () => {
  const pdfText = `
Preprint Paper Title
Alice Smith, Bob Jones
arXiv:2401.00001
Abstract
We present a new algorithm for neural processing.

1. Introduction
Content of introduction...

References
[1] Some Software, Zenodo, https://doi.org/10.5281/zenodo.1234567
[2] Another Paper, https://doi.org/10.1016/j.jcp.2020.01.001
`.trim();

  // 参考文献にある Zenodo DOI や引用論文の DOI は false
  assert.equal(isDoiGroundedInPdfText("10.5281/zenodo.1234567", pdfText), false);
  assert.equal(isDoiGroundedInPdfText("10.1016/j.jcp.2020.01.001", pdfText), false);
});

test("issue 339: isDoiGroundedInPdfText は先頭ページにある DOI を採用する", () => {
  const pdfText = `
Published Paper Title
Alice Smith, Bob Jones
Journal of Machine Learning, Vol. 10
DOI: 10.1016/j.jml.2024.100123
Abstract
We present a new algorithm for neural processing.

1. Introduction
Content of introduction...

References
[1] Some Software, Zenodo, https://doi.org/10.5281/zenodo.1234567
`.trim();

  // 先頭ページの論文自身の DOI は true
  assert.equal(isDoiGroundedInPdfText("10.1016/j.jml.2024.100123", pdfText), true);
  // 参考文献の DOI は false
  assert.equal(isDoiGroundedInPdfText("10.5281/zenodo.1234567", pdfText), false);
});

test("issue 339: isDoiGroundedInPdfText は先頭ページと参考文献の両方にある DOI を採用する", () => {
  const myDoi = "10.1016/j.jml.2024.100123";
  const pdfText = `
Published Paper Title
Alice Smith, Bob Jones
Journal of Machine Learning, Vol. 10
DOI: ${myDoi}
Abstract
We present a new algorithm for neural processing.

1. Introduction
Content of introduction...

References
[1] Alice Smith, Previous version of this paper, https://doi.org/${myDoi}
[2] Some Software, Zenodo, https://doi.org/10.5281/zenodo.1234567
`.trim();

  // 先頭ページにあれば（参考文献に重複引用されていても）採用する
  assert.equal(isDoiGroundedInPdfText(myDoi, pdfText), true);
  // 参考文献にしかないものは不採用
  assert.equal(isDoiGroundedInPdfText("10.5281/zenodo.1234567", pdfText), false);
});

test("issue 339: isDoiGroundedInPdfText は参考文献の見出しがない PDF でも先頭ページの DOI を採用する", () => {
  const myDoi = "10.1016/j.jml.2024.100123";
  const pdfText = `
Short Abstract Title
Alice Smith, Bob Jones
DOI: ${myDoi}
Abstract
This is a short workshop abstract without a formal references section.
${"More text content for abstract length requirement. ".repeat(4)}
`.trim();

  assert.equal(isDoiGroundedInPdfText(myDoi, pdfText), true);
  assert.equal(isDoiGroundedInPdfText("10.9999/nonexistent", pdfText), false);
});

test("issue 339: isDoiGroundedInPdfText は日本語の参考文献見出しにも対応する", () => {
  const myDoi = "10.1234/sice.2024.01";
  const refDoi = "10.5281/zenodo.9999";
  const pdfText = `
教育システム研究論文
山田太郎
DOI: ${myDoi}
概要
研究内容の要約文。

1. はじめに
導入文...

【参考文献】
[1] 参考オープンソースソフトウェア, https://doi.org/${refDoi}
`.trim();

  assert.equal(isDoiGroundedInPdfText(myDoi, pdfText), true);
  assert.equal(isDoiGroundedInPdfText(refDoi, pdfText), false);
});

test("issue 339: isDoiGroundedInPdfText は各ページのヘッダー・フッターにある DOI を採用する", () => {
  const myDoi = "10.1016/j.jml.2024.100123";
  const pdfText = `Title Page Without DOI
Alice Smith
Abstract text here.
${"Abstract description text. ".repeat(6)}
\fJournal of ML 2024, DOI: ${myDoi}
Section 2. Method
Body content on page 2.
References
[1] Other ref https://doi.org/10.5281/zenodo.12345
`.trim();

  assert.equal(isDoiGroundedInPdfText(myDoi, pdfText), true);
  assert.equal(isDoiGroundedInPdfText("10.5281/zenodo.12345", pdfText), false);
});


