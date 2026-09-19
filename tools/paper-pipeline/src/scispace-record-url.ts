export type SciSpaceHrefRow = {
  href: string;
  text?: string;
  row?: string;
};

export function isSciSpaceRecordUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(?:^|\.)scispace\.com$/i.test(u.hostname) && /^\/records\/[^/]+/.test(u.pathname);
  } catch {
    return false;
  }
}

export function isSciSpaceFolderUrl(url: string): boolean {
  try {
    return /\/folder\//i.test(new URL(url).pathname);
  } catch {
    return /\/folder\//i.test(url);
  }
}

export function canonicalSciSpaceRecordUrl(url: string): string {
  const u = new URL(url);
  const m = u.pathname.match(/^\/records\/([^/?#]+)/i);
  if (!m) return url;
  return `https://scispace.com/records/${m[1]}`;
}

export function filenameRecordHints(filename: string): string[] {
  const stem = filename.replace(/\.pdf$/i, "").trim().toLowerCase();
  const dashed = stem.replace(/\./g, "-");
  const compact = stem.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
  return [...new Set([stem, dashed, compact].filter((s) => s.length >= 3))];
}

export function pickSciSpaceRecordUrl(rows: SciSpaceHrefRow[], filename: string): string {
  const hints = filenameRecordHints(filename);
  const records = rows
    .map((r) => {
      const href = (r.href || "").trim();
      if (!isSciSpaceRecordUrl(href)) return null;
      return {
        url: canonicalSciSpaceRecordUrl(href),
        blob: `${href}\n${r.text || ""}\n${r.row || ""}`.toLowerCase(),
      };
    })
    .filter((r): r is { url: string; blob: string } => Boolean(r));
  const hit =
    records.find((r) => hints.some((h) => r.blob.includes(h))) ??
    (records.length === 1 ? records[0] : undefined);
  return hit?.url ?? "";
}
