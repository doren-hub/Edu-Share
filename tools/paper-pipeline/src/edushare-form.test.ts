import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_AUTHOR_NAME,
  authorFromFilesPaste,
  choosePaperAuthor,
  cleanAuthorName,
  fallbackAuthorName,
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
