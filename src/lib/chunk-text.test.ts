import test from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "./chunk-text.ts";

test("chunkText: 空文字列は空配列を返す", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   "), []);
});

test("chunkText: 通常の文章を分割し各チャンクが非空であること", () => {
  const sentence = "これはテスト文章です。Next.js アプリケーションで動作します。";
  const chunks = chunkText(sentence);
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0], sentence);
  for (const c of chunks) {
    assert.ok(c.length > 15);
  }
});

test("chunkText: サロゲートペア（astral文字 / 数式イタリック / 絵文字）の境界でペアを破壊しない", () => {
  // 数式フォントで頻出する Mathematical Italic Small X (U+1D465: \uD835\uDC65)
  // 1文字あたり UTF-16 code unit 2つ。900単位の境界にまたがるように大量に並べる
  const mathX = "\uD835\uDC65"; // 𝑥
  const longText = mathX.repeat(2000); // 4000 code units

  const chunks = chunkText(longText);
  assert.ok(chunks.length > 1, "複数チャンクに分割されること");

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    assert.ok(
      chunk.isWellFormed(),
      `チャンク #${idx} が不正なUnicodeサロゲートを含んでいないこと (isWellFormed === true)`
    );
    // 孤立した high または low surrogate が存在しないことを検証
    for (let c = 0; c < chunk.length; c++) {
      const code = chunk.charCodeAt(c);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = chunk.charCodeAt(c + 1);
        assert.ok(
          next >= 0xdc00 && next <= 0xdfff,
          `high surrogate の直後は必ず low surrogate であること (チャンク #${idx}, offset ${c})`
        );
        c++; // pair
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        assert.fail(`孤立した low surrogate が検出されました (チャンク #${idx}, offset ${c})`);
      }
    }
  }
});

test("chunkText: 絵文字が混ざった長いテキストでもすべてのチャンクが isWellFormed を満たす", () => {
  const textWithEmoji = ("テスト文章です。🎉🚀" + "あ".repeat(880) + "💡").repeat(5);
  const chunks = chunkText(textWithEmoji);
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) {
    assert.ok(chunk.isWellFormed());
  }
});
