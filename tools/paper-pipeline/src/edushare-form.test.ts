import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_AUTHOR_NAME,
  authorFromFilesPaste,
  fallbackAuthorName,
  isAuthorRequiredError,
  pickAuthorSelectValue,
} from "./edushare-form.ts";

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
