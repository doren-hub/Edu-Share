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

export function parseArxivAtomAuthors(xml: string): string[] {
  const names: string[] = [];
  const re = /<author>\s*<name>([\s\S]*?)<\/name>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const n = m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (n) names.push(n);
  }
  return names;
}

export function parseArxivAtomYear(xml: string): string {
  const m = xml.match(/<published>(\d{4})/i) || xml.match(/<updated>(\d{4})/i);
  return m?.[1] ?? "";
}

export function parseArxivAtomTitle(xml: string): string {
  const entry = xml.match(/<entry\b[\s\S]*?<\/entry>/i)?.[0] ?? xml;
  const m = entry.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
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

export async function fetchArxivAtom(id: string): Promise<string> {
  const key = id.trim();
  if (!key) return "";
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return "";
  return res.text();
}

export async function fetchArxivAbstract(id: string): Promise<string> {
  return parseArxivAtomSummary(await fetchArxivAtom(id));
}
