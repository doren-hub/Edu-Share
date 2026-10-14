import test from "node:test";
import assert from "node:assert/strict";
import { extractPdfText } from "./pdf-text.ts";

test("extractPdfText: 存在しないパスや空バッファは空文字を返す", async () => {
  assert.equal(await extractPdfText(""), "");
  assert.equal(await extractPdfText("/nonexistent/file.pdf"), "");
  assert.equal(await extractPdfText(Buffer.from([])), "");
});

test("extractPdfText: 破損したバッファでもエラーを投げず空文字を返す", async () => {
  assert.equal(await extractPdfText(Buffer.from("invalid pdf content")), "");
});

test("extractPdfText: テキストのない最小 PDF からは空文字を取り出す", async () => {
  const blankPdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 300 144]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n",
  );
  const text = await extractPdfText(blankPdf);
  assert.equal(typeof text, "string");
  assert.equal(text.trim(), "");
});
