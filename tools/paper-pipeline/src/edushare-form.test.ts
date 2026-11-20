import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_AUTHOR_NAME,
  authorFromFilesPaste,
  choosePaperAuthor,
  cleanAuthorName,
  fallbackAuthorName,
  isAuthorGroundedInPdfFirstPage,
  isAuthorRequiredError,
  isDummyAuthorValue,
  materialCarouselShowLabel,
  notebookLmCsvPoolImported,
  notebookLmMaterialBlockIsRegistered,
  paperMaterialIsRegistered,
  pickAuthorSelectValue,
  SLIDE_MATERIAL_HEADING,
  VIDEO_MATERIAL_HEADING,
} from "./edushare-form.ts";

test("notebookLmCsvPoolImported: その欄の取り込み済みだけを見る", () => {
  assert.equal(notebookLmCsvPoolImported("クイズ（選択肢） 取り込み済み（12問）"), true);
  assert.equal(notebookLmCsvPoolImported("クイズ（選択肢） 未取り込み"), false);
  assert.equal(notebookLmCsvPoolImported("単語帳（Flashcard） 取り込み済み（40問）"), true);
  assert.equal(notebookLmCsvPoolImported(""), false);
});

test("pickAuthorSelectValue: 空とその他を飛ばして実名を返す", () => {
  assert.equal(pickAuthorSelectValue(["", "選択してください", "その他"]), null);
  assert.equal(
    pickAuthorSelectValue(["", "選択してください", "Galina Weinstein", "その他"]),
    "Galina Weinstein",
  );
});

test("pickAuthorSelectValue: デモの A. Einstein は使わない", () => {
  assert.equal(pickAuthorSelectValue(["", "A. Einstein", "その他"]), null);
  assert.equal(
    pickAuthorSelectValue(["", "A. Einstein", "Karl Popper", "その他"]),
    "Karl Popper",
  );
});

test("isDummyAuthorValue: デモの Dewdney も実著者ではない", () => {
  assert.equal(isDummyAuthorValue("A. K. Dewdney"), true);
  assert.equal(isDummyAuthorValue("Vardhan Dongre"), false);
});

test("notebookLmMaterialBlockIsRegistered: 未登録を登録済みと取り違えない", () => {
  assert.equal(
    notebookLmMaterialBlockIsRegistered("スライド（PDF）\n未登録"),
    false,
  );
  assert.equal(
    notebookLmMaterialBlockIsRegistered("動画（MP4）\n登録済み"),
    true,
  );
  assert.equal(notebookLmMaterialBlockIsRegistered("スライド（PDF）"), false);
});

test("materialCarouselShowLabel / paperMaterialIsRegistered", () => {
  assert.equal(materialCarouselShowLabel(SLIDE_MATERIAL_HEADING), "スライド（PDF）を表示");
  assert.equal(materialCarouselShowLabel(VIDEO_MATERIAL_HEADING), "動画（MP4）を表示");
  assert.equal(
    paperMaterialIsRegistered({ formBlockText: "スライド（PDF）\n未登録", hasViewerPane: true }),
    true,
  );
  assert.equal(
    paperMaterialIsRegistered({ formBlockText: "スライド（PDF）\n未登録", hasViewerPane: false }),
    false,
  );
  assert.equal(
    paperMaterialIsRegistered({ formBlockText: "動画（MP4）\n登録済み", hasViewerPane: false }),
    true,
  );
});

test("choosePaperAuthor: デモ著者は捨てて Files 貼り付けの先頭名を入れる", () => {
  assert.deepEqual(
    choosePaperAuthor({
      current: "A. K. Dewdney",
      optionValues: ["", "A. K. Dewdney", "Karl Popper", "その他"],
      filesPaste:
        "2510.07777v1.pdf\nDrift No More?\n2025\u22c5Vardhan Dongre, Ryan A. Rossi...+4 More\narXiv",
      title: "Drift No More?",
      filename: "2510.07777v1.pdf",
    }),
    { action: "other", value: "Vardhan Dongre" },
  );
});

test("choosePaperAuthor: 貼り付けと同じ実著者は維持する", () => {
  assert.deepEqual(
    choosePaperAuthor({
      current: "Vardhan Dongre",
      optionValues: ["", "Vardhan Dongre", "その他"],
      filesPaste: "a.pdf\nTitle\n2025\u22c5Vardhan Dongre, Ryan A. Rossi\narXiv",
      title: "Title",
      filename: "a.pdf",
    }),
    { action: "keep", value: "Vardhan Dongre" },
  );
});

test("choosePaperAuthor: 貼り付けから著者が取れないときは無関係な既存著者を選ばずフォールバックする", () => {
  const optionValues = ["", "選択してください", "A. Ashtekar", "Karl Popper", "その他"];
  assert.equal(pickAuthorSelectValue(optionValues), "A. Ashtekar");

  assert.deepEqual(
    choosePaperAuthor({
      current: "",
      optionValues,
      filesPaste: "",
      title: "Some Paper Without Authors",
      filename: "paper.pdf",
    }),
    { action: "other", value: FALLBACK_AUTHOR_NAME },
  );
});

test("choosePaperAuthor: 貼り付けから著者が取れないときでもフォールバック名と一致する選択肢があれば選ぶ", () => {
  const optionValues = ["", "A. Ashtekar", FALLBACK_AUTHOR_NAME, "その他"];
  assert.deepEqual(
    choosePaperAuthor({
      current: "",
      optionValues,
      filesPaste: "",
      title: "Some Paper Without Authors",
      filename: "paper.pdf",
    }),
    { action: "select", value: FALLBACK_AUTHOR_NAME },
  );
});

test("choosePaperAuthor: デモ著者で貼り付けが無いときも無関係な既存著者を選ばない", () => {
  const optionValues = ["", "A. Einstein", "A. Ashtekar", "その他"];
  assert.deepEqual(
    choosePaperAuthor({
      current: "A. Einstein",
      optionValues,
      filesPaste: "",
      title: "Report",
      filename: "report.pdf",
    }),
    { action: "other", value: FALLBACK_AUTHOR_NAME },
  );
});

test("authorFromFilesPaste: Authors / 著者行の先頭名", () => {
  assert.equal(authorFromFilesPaste("Title: Foo\nAuthors: Jane Doe, John Smith\n"), "Jane Doe");
  assert.equal(authorFromFilesPaste("著者: 山田 太郎、鈴木"), "山田 太郎");
  assert.equal(authorFromFilesPaste("DOI: 10.1/x"), "");
});

test("authorFromFilesPaste: SciSpace の年·DOI·著者行からも取る", () => {
  assert.equal(
    authorFromFilesPaste(
      "All objects and some questions\n2023\u22c5DOI\u22c5Charles H. Lineweaver, Vihan M. Patel\nAmerican Journal of Physics",
    ),
    "Charles H. Lineweaver",
  );
});

test("fallbackAuthorName: 貼り付けが無ければ著者未設定", () => {
  assert.equal(
    fallbackAuthorName({
      filesPaste: "",
      title: "0709.2257v2",
      filename: "0709.2257v2.pdf",
    }),
    FALLBACK_AUTHOR_NAME,
  );
  assert.equal(
    fallbackAuthorName({
      filesPaste: "Authors: Ada Lovelace\n",
      title: "x",
      filename: "x.pdf",
    }),
    "Ada Lovelace",
  );
  assert.equal(
    fallbackAuthorName({
      filesPaste:
        "All objects and some questions\n2023\u22c5DOI\u22c5Charles H. Lineweaver, Vihan M. Patel",
      title: "All objects and some questions",
      filename: "LineweaverPatel2023final.pdf",
    }),
    "Charles H. Lineweaver",
  );
});

test("isAuthorRequiredError", () => {
  assert.equal(isAuthorRequiredError("論文では著者を1人以上選択してください"), true);
  assert.equal(isAuthorRequiredError("タイトルを入力してください"), false);
});

test("Issue #132: cleanAuthorName は Show Less と +N More を取り除き単体表記は空にする", () => {
  assert.equal(cleanAuthorName("Trung BuiShow Less"), "Trung Bui");
  assert.equal(cleanAuthorName("Trung Bui Show Less"), "Trung Bui");
  assert.equal(cleanAuthorName("Raad Khraishi ...+2 More"), "Raad Khraishi");
  assert.equal(cleanAuthorName("Raad Khraishi +2 More"), "Raad Khraishi");
  assert.equal(cleanAuthorName("+2 More"), "");
  assert.equal(cleanAuthorName("...+4 More"), "");
  assert.equal(cleanAuthorName("Show Less"), "");
});

test("Issue #132: authorFromFilesPaste と choosePaperAuthor は +N More を著者名にしない", () => {
  const pasteOnlyMore = "2505.06120v1.pdf\nTitle\n2025 · ...+5 More\narXiv";
  assert.equal(authorFromFilesPaste(pasteOnlyMore), "");
  assert.deepEqual(
    choosePaperAuthor({
      current: "",
      optionValues: ["", "Karl Popper", "その他"],
      filesPaste: pasteOnlyMore,
      title: "Title",
      filename: "2505.06120v1.pdf",
    }),
    { action: "other", value: FALLBACK_AUTHOR_NAME },
  );

  const pasteShowLess = "paper.pdf\nTitle\n2025 · Vardhan DongreShow Less\narXiv";
  assert.equal(authorFromFilesPaste(pasteShowLess), "Vardhan Dongre");
  assert.deepEqual(
    choosePaperAuthor({
      current: "",
      optionValues: ["", "その他"],
      filesPaste: pasteShowLess,
      title: "Title",
      filename: "paper.pdf",
    }),
    { action: "other", value: "Vardhan Dongre" },
  );
});

test("Issue #333: authorFromFilesPaste は DOI, III, 不明, Graphs を除外し Hugh Everett, III や OPENAI を受け付ける", () => {
  assert.equal(authorFromFilesPaste("Title: Foo\nAuthors: DOI\n"), "");
  assert.equal(authorFromFilesPaste("Title: Foo\n2024 ⋅ DOI\n"), "");
  assert.equal(authorFromFilesPaste("Title: Foo\n2024 ⋅ III\n"), "");
  assert.equal(authorFromFilesPaste("Title: Foo\n著者: 不明\n"), "");
  assert.equal(authorFromFilesPaste("Title: Foo\nAuthors: Graphs\n"), "");

  assert.equal(authorFromFilesPaste("Title: Quantum\n2024 ⋅ Hugh Everett, III\n"), "Hugh Everett, III");
  assert.equal(authorFromFilesPaste("Title: Quantum\nAuthors: Hugh Everett, III, John Wheeler\n"), "Hugh Everett, III");
  assert.equal(authorFromFilesPaste("Title: GPT\n2024 ⋅ OPENAI\n"), "OPENAI");
  assert.equal(authorFromFilesPaste("Title: Rover\nAuthors: nasa\n"), "nasa");
});

test("Issue #333: fallbackAuthorName と choosePaperAuthor: Files に著者がなく PDF 1 ページ目にあるとき PDF 著者を補う（日本語・英語）", () => {
  const enPdfText = `
Deep Residual Learning for Image Recognition
Kaiming He
Xiangyu Zhang
Microsoft Research
Abstract
Deeper neural networks are more difficult to train...
`;
  const jaPdfText = `
深層学習を用いた自然言語処理の動向
山田 太郎†　佐藤 花子‡
†東京大学
要旨
本稿では近年の発展を述べる。
`;

  // 英語 PDF
  assert.equal(
    fallbackAuthorName({
      filesPaste: "paper.pdf\nDeep Residual Learning",
      title: "Deep Residual Learning for Image Recognition",
      filename: "paper.pdf",
      pdfText: enPdfText,
    }),
    "Kaiming He",
  );
  assert.deepEqual(
    choosePaperAuthor({
      current: "",
      optionValues: ["", "その他"],
      filesPaste: "paper.pdf\nDeep Residual Learning",
      title: "Deep Residual Learning for Image Recognition",
      filename: "paper.pdf",
      pdfText: enPdfText,
    }),
    { action: "other", value: "Kaiming He" },
  );

  // 日本語 PDF
  assert.equal(
    fallbackAuthorName({
      filesPaste: "paper.pdf\n深層学習",
      title: "深層学習を用いた自然言語処理の動向",
      filename: "paper.pdf",
      pdfText: jaPdfText,
    }),
    "山田 太郎",
  );
  assert.deepEqual(
    choosePaperAuthor({
      current: "",
      optionValues: ["", "その他"],
      filesPaste: "paper.pdf\n深層学習",
      title: "深層学習を用いた自然言語処理の動向",
      filename: "paper.pdf",
      pdfText: jaPdfText,
    }),
    { action: "other", value: "山田 太郎" },
  );
});

test("Issue #333: fallbackAuthorName と choosePaperAuthor: Files にも PDF 1 ページ目にも著者がなく DOI 照会で著者が返るとき DOI 著者を補う", () => {
  const scannedPdfText = "Image only scanned document without extracted text\n1. Introduction";
  assert.equal(
    fallbackAuthorName({
      filesPaste: "paper.pdf\nTitle",
      title: "Title",
      filename: "paper.pdf",
      pdfText: scannedPdfText,
      doiAuthor: "Jane Doe",
    }),
    "Jane Doe",
  );
  assert.deepEqual(
    choosePaperAuthor({
      current: "",
      optionValues: ["", "その他"],
      filesPaste: "paper.pdf\nTitle",
      title: "Title",
      filename: "paper.pdf",
      pdfText: scannedPdfText,
      doiAuthor: "Jane Doe",
    }),
    { action: "other", value: "Jane Doe" },
  );
});

test("Issue #333: choosePaperAuthor: 現在値が DOI や III などのおかしい値の場合は維持せずフォールバックする", () => {
  assert.deepEqual(
    choosePaperAuthor({
      current: "DOI",
      optionValues: ["", "その他"],
      filesPaste: "",
      title: "Title",
      filename: "paper.pdf",
      doiAuthor: "Jane Doe",
    }),
    { action: "other", value: "Jane Doe" },
  );
  assert.deepEqual(
    choosePaperAuthor({
      current: "III",
      optionValues: ["", "その他"],
      filesPaste: "",
      title: "Title",
      filename: "paper.pdf",
      doiAuthor: "Hugh Everett, III",
    }),
    { action: "other", value: "Hugh Everett, III" },
  );
  assert.deepEqual(
    choosePaperAuthor({
      current: "不明",
      optionValues: ["", "その他"],
      filesPaste: "",
      title: "Title",
      filename: "paper.pdf",
    }),
    { action: "other", value: FALLBACK_AUTHOR_NAME },
  );
});

test("Issue #341: choosePaperAuthor: 今の値が PDF 先頭ページにない無関係な名前のとき、維持せず PDF 著者に置き換える", () => {
  const title = "Deep Residual Learning for Image Recognition";
  const pdfText = `${title}\nKaiming He, Xiangyu Zhang\nMicrosoft Research\nAbstract\nDeeper neural networks are more difficult to train...\n${"Detailed research content meeting minimum length. ".repeat(4)}`;

  // カード著者なし、フォーム現在値が無関係な組織名「Some Organization」（PDF 先頭ページにない）
  assert.deepEqual(
    choosePaperAuthor({
      current: "Some Organization",
      optionValues: ["", "Some Organization", "その他"],
      filesPaste: "",
      title,
      filename: "resnet.pdf",
      pdfText,
    }),
    { action: "other", value: "Kaiming He" },
  );

  // 選択肢に PDF 著者がある場合は select で選ばれる
  assert.deepEqual(
    choosePaperAuthor({
      current: "Some Organization",
      optionValues: ["", "Some Organization", "Kaiming He", "その他"],
      filesPaste: "",
      title,
      filename: "resnet.pdf",
      pdfText,
    }),
    { action: "select", value: "Kaiming He" },
  );
});

test("Issue #341: choosePaperAuthor: 今の値が PDF 先頭ページにある名前のときは keep で維持する", () => {
  const title = "Deep Residual Learning for Image Recognition";
  const pdfText = `${title}\nKaiming He, Xiangyu Zhang\nMicrosoft Research\nAbstract\nDeeper neural networks are more difficult to train...\n${"Detailed research content meeting minimum length. ".repeat(4)}`;

  // カード著者なしでも、現在の値が PDF 先頭ページの人名であれば keep
  assert.deepEqual(
    choosePaperAuthor({
      current: "Kaiming He",
      optionValues: ["", "Kaiming He", "その他"],
      filesPaste: "",
      title,
      filename: "resnet.pdf",
      pdfText,
    }),
    { action: "keep", value: "Kaiming He" },
  );

  // 組織名であっても PDF 先頭ページにある正当な著者であれば keep
  const orgTitle = "GPT-4 Technical Report";
  const orgPdfText = `${orgTitle}\nOPENAI\nAbstract\nWe report the development of GPT-4...\n${"Detailed content meeting minimum length. ".repeat(4)}`;
  assert.deepEqual(
    choosePaperAuthor({
      current: "OPENAI",
      optionValues: ["", "OPENAI", "その他"],
      filesPaste: "",
      title: orgTitle,
      filename: "gpt4.pdf",
      pdfText: orgPdfText,
    }),
    { action: "keep", value: "OPENAI" },
  );
});

test("Issue #341: choosePaperAuthor: PDF の本文が読めない（スキャンなど）ときは今までどおり keep で維持する", () => {
  const title = "Scanned Historical Paper";
  const scannedPdfText = "Image only scanned document without extracted text\n1. Introduction";

  // PDF がスキャンの場合は、現在の値を維持する
  assert.deepEqual(
    choosePaperAuthor({
      current: "Existing Author",
      optionValues: ["", "Existing Author", "その他"],
      filesPaste: "",
      title,
      filename: "scanned.pdf",
      pdfText: scannedPdfText,
    }),
    { action: "keep", value: "Existing Author" },
  );

  // pdfText が未指定（undefined）の場合も同様に維持する
  assert.deepEqual(
    choosePaperAuthor({
      current: "Existing Author",
      optionValues: ["", "Existing Author", "その他"],
      filesPaste: "",
      title,
      filename: "scanned.pdf",
    }),
    { action: "keep", value: "Existing Author" },
  );
});

test("Issue #341: choosePaperAuthor: 今の値が PDF 先頭ページになく PDF からも取れないときは DOI 著者、それも無ければ著者未設定に倒す", () => {
  const title = "Title";
  // PDF テキストはあるが人名著者行がない
  const pdfText = `${title}\nAbstract\nThis paper discusses observations without listing authors.\n${"Detailed content meeting minimum length. ".repeat(4)}`;

  // DOI 著者がある場合は DOI 著者に置き換わる
  assert.deepEqual(
    choosePaperAuthor({
      current: "Unrelated Org",
      optionValues: ["", "Unrelated Org", "その他"],
      filesPaste: "",
      title,
      filename: "paper.pdf",
      pdfText,
      doiAuthor: "Jane Doe",
    }),
    { action: "other", value: "Jane Doe" },
  );

  // DOI 著者もない場合は著者未設定に置き換わる
  assert.deepEqual(
    choosePaperAuthor({
      current: "Unrelated Org",
      optionValues: ["", "Unrelated Org", "その他"],
      filesPaste: "",
      title,
      filename: "paper.pdf",
      pdfText,
    }),
    { action: "other", value: FALLBACK_AUTHOR_NAME },
  );
});
