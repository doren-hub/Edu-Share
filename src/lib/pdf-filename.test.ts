import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePdfFilename, pdfFilenamesEqual } from "./pdf-filename.ts";

test("normalizePdfFilename: パスと拡張子と大小文字を揃える", () => {
  assert.equal(normalizePdfFilename("hawking.pdf"), "hawking.pdf");
  assert.equal(normalizePdfFilename("Hawking.PDF"), "hawking.pdf");
  assert.equal(normalizePdfFilename("hawking"), "hawking.pdf");
  assert.equal(normalizePdfFilename("inbox/2603.03111v1.pdf"), "2603.03111v1.pdf");
});

test("pdfFilenamesEqual: 名称が同じなら真、タイトル相当は見ない", () => {
  assert.equal(pdfFilenamesEqual("hawking.pdf", "hawking"), true);
  assert.equal(
    pdfFilenamesEqual("hawking.pdf", "Particle Creation by Black Holes"),
    false,
  );
});
