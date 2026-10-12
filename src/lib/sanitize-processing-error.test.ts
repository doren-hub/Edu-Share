import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeProcessingError } from "./sanitize-processing-error.ts";

test("sanitizeProcessingError: 既知のエラー文言を安全な日本語メッセージへ正規化する", () => {
  assert.equal(
    sanitizeProcessingError(new Error("unsupported Unicode escape sequence: \\u0000 cannot be converted to text")),
    "PDF本文に含まれるUnicode文字の処理に失敗しました。",
  );
  assert.equal(
    sanitizeProcessingError("401 Incorrect API key provided: your_openai_key"),
    "埋め込みAPIの認証に失敗しました。管理者へお問い合わせください。",
  );
  assert.equal(
    sanitizeProcessingError(new Error("R2へのアップロードに失敗しました")),
    "ファイルストレージへの保存に失敗しました。時間をおいて再試行してください。",
  );
  assert.equal(
    sanitizeProcessingError(new Error("PDFの解析に失敗しました（暗号化PDFや破損ファイルの可能性があります）: No password given")),
    "PDFの解析に失敗しました（暗号化PDFや破損ファイルの可能性があります）。",
  );
  assert.equal(
    sanitizeProcessingError(new Error("PDFの解析に失敗しました（暗号化PDFや破損ファイルの可能性があります）: corrupt stream")),
    "PDFの解析に失敗しました（暗号化PDFや破損ファイルの可能性があります）。",
  );
});

test("sanitizeProcessingError: 本文自動抽出エラーはそのまま保持する", () => {
  const msg = "PDFから本文テキストを自動抽出できませんでした（画像のみ・スキャンなどの可能性）。テキストがコピーできるPDFへの差し替えを推奨します。";
  assert.equal(sanitizeProcessingError(msg), msg);
});

test("sanitizeProcessingError: 未知の例外メッセージは安全な定型文へ置き換える", () => {
  const longErr = "Some unknown internal database error: relation tests does not exist";
  const result = sanitizeProcessingError(new Error(longErr));
  assert.equal(
    result,
    "PDFの取り込みに失敗しました。時間をおいて再試行するか、別のPDFをお試しください。",
  );
});
