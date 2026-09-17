/**
 * PDF から抽出したテキストのサニタイズ。
 *
 * 学術論文などで使われる特殊フォント（数式・記号用の独自エンコーディング）は、
 * pdf.js / pdf-parse のテキスト抽出時に、グリフ→Unicode変換が正しく行われず
 * NUL 文字（\u0000）や他の制御文字、対になっていない（不正な）サロゲートを
 * 生成することがある。
 *
 * これらの文字は PostgreSQL の text/jsonb 型に格納できず、Supabase 経由での
 * insert 時に「unsupported Unicode escape sequence」エラーの原因になるため、
 * DB へ保存する前に必ず取り除く。
 */
export function sanitizeExtractedPdfText(input: string): string {
  if (!input) return input;

  let out = "";
  let changed = false;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);

    // NUL 文字は PostgreSQL の text 型に一切格納できないため除去
    if (code === 0) {
      changed = true;
      continue;
    }

    // タブ・改行・復帰以外の制御文字（フォントの誤マッピングに由来）は除去
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      changed = true;
      continue;
    }

    // サロゲートペアの整合性チェック
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1];
        i++;
        continue;
      }
      // 対になっていない high surrogate は置換文字に差し替え
      out += "\uFFFD";
      changed = true;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // 直前が high surrogate でない単独の low surrogate も置換
      out += "\uFFFD";
      changed = true;
      continue;
    }

    out += input[i];
  }

  return changed ? out : input;
}
