/** DOI から Crossref の書誌を取る（SciSpace がデモカードのときの補完） */

export type CrossrefWork = {
  title: string;
  authors: string[];
  year: string;
  venue: string;
  doi: string;
};

function decodeCrossrefText(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function yearFromDateParts(parts: unknown): string {
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return "";
  const y = parts[0][0];
  return typeof y === "number" && y >= 1900 && y <= 2100 ? String(y) : "";
}

function authorName(a: { given?: string; family?: string; name?: string }): string {
  const named = decodeCrossrefText(a.name ?? "");
  if (named) return named;
  return [a.given, a.family].map((p) => decodeCrossrefText(p ?? "")).filter(Boolean).join(" ").trim();
}

export function parseCrossrefWork(json: string): CrossrefWork | null {
  let data: {
    message?: {
      DOI?: string;
      title?: unknown;
      author?: Array<{ given?: string; family?: string; name?: string }>;
      "container-title"?: unknown;
      issued?: { "date-parts"?: unknown };
      "published-print"?: { "date-parts"?: unknown };
      "published-online"?: { "date-parts"?: unknown };
    };
  };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return null;
  }
  const msg = data.message;
  if (!msg) return null;
  const titleRaw = Array.isArray(msg.title) ? String(msg.title[0] ?? "") : String(msg.title ?? "");
  const title = decodeCrossrefText(titleRaw);
  const authors = (msg.author ?? []).map(authorName).filter((n) => n.length >= 2);
  const venueRaw = Array.isArray(msg["container-title"])
    ? String(msg["container-title"][0] ?? "")
    : String(msg["container-title"] ?? "");
  const venue = decodeCrossrefText(venueRaw);
  const year =
    yearFromDateParts(msg["published-print"]?.["date-parts"]) ||
    yearFromDateParts(msg["published-online"]?.["date-parts"]) ||
    yearFromDateParts(msg.issued?.["date-parts"]);
  const doi = decodeCrossrefText(msg.DOI ?? "");
  if (!title || authors.length === 0) return null;
  return { title, authors, year, venue, doi };
}

export function bibliographicPasteFromWork(filename: string, work: CrossrefWork): string {
  const line = work.year ? `${work.year}⋅${work.authors.join(", ")}` : work.authors.join(", ");
  return [filename, work.title, line, work.venue].filter((s) => s.trim()).join("\n");
}

export async function fetchCrossrefWork(doi: string): Promise<CrossrefWork | null> {
  const key = doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  if (!key) return null;
  const url = `https://api.crossref.org/works/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": "edu-share-paper-pipeline/0.1 (https://github.com/doren-hub/Edu-Share)" },
  });
  if (!res.ok) return null;
  return parseCrossrefWork(await res.text());
}
