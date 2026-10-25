import { normalizePaperDoiDisplay } from "./paper-doi.ts";

export type GoogleAiSearchParams = {
  title: string;
  doi?: string | null;
  question?: string | null;
};

/**
 * Google 検索クエリの最大文字数（デフォルト 1,000 文字）。
 * URL の肥大化やブラウザ・プロキシによる切り捨てを防ぐための安全な上限。
 */
export const DEFAULT_MAX_QUERY_LENGTH = 1000;

/**
 * サロゲートペアを壊さずに文字列を安全に切り詰める。
 */
function safeTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let truncated = text.slice(0, maxLength);
  const lastCode = truncated.charCodeAt(truncated.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    // 末尾が上位サロゲート（下位サロゲートが欠落）の場合は削る
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

/**
 * 論文タイトル、DOI（あれば）、質問文を Google AI モード用の検索クエリ文面に組み立てる。
 *
 * 渡すのはタイトル・DOI・質問文だけ（本文・著者のメモ・ユーザー情報は含めない）。
 * 質問が空のときは、タイトルだけで開く。
 */
export function buildGoogleAiSearchQueryText(
  params: GoogleAiSearchParams,
  options?: { maxLength?: number },
): string {
  const title = (params.title ?? "").trim();
  const rawQuestion = (params.question ?? "").trim();
  const rawDoi = params.doi ? normalizePaperDoiDisplay(params.doi) : "";
  const maxLength = options?.maxLength ?? DEFAULT_MAX_QUERY_LENGTH;

  let query: string;
  if (!rawQuestion) {
    // 質問が空のときは、タイトルだけで開く
    query = title;
  } else {
    const parts: string[] = [];
    if (title) parts.push(title);
    if (rawDoi) parts.push(`(DOI: ${rawDoi})`);
    parts.push(rawQuestion);
    query = parts.join(" ");
  }

  return safeTruncate(query, maxLength);
}

/**
 * Google 検索の AI モード（udm=50）で開く URL を組み立てる。
 * URL は URL エンコードされ、長すぎるときはクエリが切り詰められる。
 */
export function buildGoogleAiSearchUrl(
  params: GoogleAiSearchParams,
  options?: { maxLength?: number },
): string {
  const query = buildGoogleAiSearchQueryText(params, options);
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("udm", "50");
  url.searchParams.set("q", query);
  return url.toString();
}
