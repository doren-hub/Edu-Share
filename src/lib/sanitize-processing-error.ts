/**
 * エラーオブジェクトや文字列から、安全で分かりやすい表示用メッセージを作成する。
 * データベースの生エラーや接続情報・秘密情報を外部へ露出させない。
 */
export function sanitizeProcessingError(e: unknown): string {
  if (!e) return "処理に失敗しました";
  const msg = e instanceof Error ? e.message : String(e);

  if (/\b(?:unsupported Unicode escape sequence|Unicode escape|surrogate)\b/i.test(msg)) {
    return "PDF本文に含まれるUnicode文字の処理に失敗しました。";
  }
  if (/\b(?:Incorrect API key|api_key|API key)\b/i.test(msg)) {
    return "埋め込みAPIの認証に失敗しました。管理者へお問い合わせください。";
  }
  if (/\b(?:R2へのアップロード|storage|R2|S3)\b/i.test(msg)) {
    return "ファイルストレージへの保存に失敗しました。時間をおいて再試行してください。";
  }
  if (
    /PDFの解析に失敗しました/i.test(msg) ||
    /\b(?:pdf-parse|no pages|Invalid PDF|password)\b/i.test(msg)
  ) {
    return "PDFの解析に失敗しました（暗号化PDFや破損ファイルの可能性があります）。";
  }
  if (/PDFから本文テキストを自動抽出できませんでした/i.test(msg)) {
    return msg;
  }
  if (/\b(?:rate limit|429)\b/i.test(msg)) {
    return "API呼び出しの上限に達しました。時間をおいて再試行してください。";
  }

  // 未知のエラーは生例外やSQL/認証情報の漏洩を防ぐため定型メッセージを返す
  return "PDFの取り込みに失敗しました。時間をおいて再試行するか、別のPDFをお試しください。";
}
