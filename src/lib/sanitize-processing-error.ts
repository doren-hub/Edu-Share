/**
 * エラーオブジェクトや文字列から、安全で分かりやすい表示用メッセージを作成する。
 * データベースの生エラーや接続情報・秘密情報を外部へ露出させない。
 */
export function sanitizeProcessingError(e: unknown): string {
  if (!e) return "処理に失敗しました";
  const msg = e instanceof Error ? e.message : String(e);

  if (/unsupported Unicode escape sequence|Unicode escape|surrogate/i.test(msg)) {
    return "PDF本文に含まれるUnicode文字の処理に失敗しました。";
  }
  if (/API key|Incorrect API key|api_key/i.test(msg)) {
    return "埋め込みAPIの認証に失敗しました。管理者へお問い合わせください。";
  }
  if (/R2へのアップロード|R2|storage|S3/i.test(msg)) {
    return "ファイルストレージへの保存に失敗しました。時間をおいて再試行してください。";
  }
  if (/PDFの解析に失敗しました|pdf-parse|no pages|Invalid PDF/i.test(msg)) {
    return "PDFの解析に失敗しました（暗号化PDFや破損ファイルの可能性があります）。";
  }
  if (/PDFから本文テキストを自動抽出できませんでした/i.test(msg)) {
    return msg;
  }
  if (/rate limit|429/i.test(msg)) {
    return "API呼び出しの上限に達しました。時間をおいて再試行してください。";
  }

  // 長すぎる生エラーやスタックトレースは切り詰める
  const clean = msg.replace(/[\r\n]+/g, " ").trim();
  if (clean.length > 120) {
    return clean.slice(0, 117) + "...";
  }
  return clean || "PDFの取り込みに失敗しました";
}
