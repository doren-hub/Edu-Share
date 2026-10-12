import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeExtractedPdfText } from "./sanitize-pdf-text.ts";

test("sanitizeExtractedPdfText: 空文字列および通常テキストはそのまま返す", () => {
  assert.equal(sanitizeExtractedPdfText(""), "");
  assert.equal(sanitizeExtractedPdfText("Hello, World!"), "Hello, World!");
  assert.equal(sanitizeExtractedPdfText("日本語のテキストです。"), "日本語のテキストです。");
  assert.equal(sanitizeExtractedPdfText("line 1\nline 2\r\ntab\ttext"), "line 1\nline 2\r\ntab\ttext");
});

test("sanitizeExtractedPdfText: PostgreSQL が拒否する NUL 文字 (\\u0000) を完全に除去する", () => {
  const input = "before\u0000after";
  const output = sanitizeExtractedPdfText(input);
  assert.equal(output, "beforeafter");
  assert.doesNotMatch(output, /\u0000/);
});

test("sanitizeExtractedPdfText: タブ・改行・復帰以外の ASCII 制御文字を除去する", () => {
  // \u0001 (SOH), \u0007 (BEL), \u0008 (BS), \u000B (VT), \u000C (FF), \u001F (US)
  const input = "a\u0001b\u0007c\u0008d\u000Be\u000Cf\u001Fg";
  const output = sanitizeExtractedPdfText(input);
  assert.equal(output, "abcdefg");

  // 許可される制御文字: \t (\u0009), \n (\u000A), \r (\u000D)
  const allowed = "a\tb\nc\rd";
  assert.equal(sanitizeExtractedPdfText(allowed), allowed);
});

test("sanitizeExtractedPdfText: 正常なサロゲートペア（絵文字・希少漢字等）は保持する", () => {
  const emoji = "😀🎉🚀";
  assert.equal(sanitizeExtractedPdfText(emoji), emoji);

  const mixed = "Text with emoji: 📄 (code: \uD83D\uDCC4)";
  assert.equal(sanitizeExtractedPdfText(mixed), mixed);
});

test("sanitizeExtractedPdfText: 対になっていない孤立サロゲートを置換文字 (\\uFFFD) に置き換える", () => {
  // 孤立した high surrogate (\uD800)
  const highAlone = "lone high: \uD83D!";
  assert.equal(sanitizeExtractedPdfText(highAlone), "lone high: \uFFFD!");

  // 孤立した low surrogate (\uDC00)
  const lowAlone = "lone low: \uDCC4!";
  assert.equal(sanitizeExtractedPdfText(lowAlone), "lone low: \uFFFD!");

  // 逆順のサロゲートペア (low + high)
  const inverted = "inverted: \uDCC4\uD83D!";
  assert.equal(sanitizeExtractedPdfText(inverted), "inverted: \uFFFD\uFFFD!");
});

test("sanitizeExtractedPdfText: 複合ケース（NUL + 制御文字 + 孤立サロゲート + 正常文字列）", () => {
  const complex = "Valid\u0000Text\u0001With\uD83D\uDCA1Lamp and\uD800Unpaired";
  const expected = "ValidTextWith\uD83D\uDCA1Lamp and\uFFFDUnpaired";
  assert.equal(sanitizeExtractedPdfText(complex), expected);
});
