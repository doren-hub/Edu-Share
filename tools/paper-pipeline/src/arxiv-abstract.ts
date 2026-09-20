/** ファイル名の arXiv ID から公式要旨を取る（SciSpace の TL;DR が空のときの補完） */

export function arxivIdFromFilename(filename: string): string {
  const stem = filename.replace(/\.pdf$/i, "").trim();
  const m = stem.match(/^(\d{4}\.\d{4,5})(?:v\d+)?$/i);
  return m?.[1] ?? "";
}

export function parseArxivAtomSummary(xml: string): string {
  const m = xml.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
  if (!m?.[1]) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchArxivAbstract(id: string): Promise<string> {
  const key = id.trim();
  if (!key) return "";
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return "";
  return parseArxivAtomSummary(await res.text());
}
