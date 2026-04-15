/**
 * Normalize DOI for display and links: strip trailing punctuation,
 * extract bare id from doi.org / ACM URLs or a `doi:` prefix.
 */
export function normalizePaperDoiDisplay(raw: string | null | undefined): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";

  const acm = s.match(/dl\.acm\.org\/doi\/(10\.[^\s?#]+)/i);
  if (acm?.[1]) s = acm[1];

  const fromDoiOrg = s.match(
    /(?:https?:\/\/)?(?:dx\.)?doi\.org\/(10\.[^\s?#]+)/i,
  );
  if (fromDoiOrg?.[1]) s = fromDoiOrg[1];

  const lower = s.toLowerCase();
  if (lower.startsWith("doi:")) s = s.slice(4).trim();

  s = s.replace(/[、,.\s）)'"\u201d]+$/u, "");
  return s.trim();
}

/** Resolver URL: ACM `10.1145/…` → dl.acm.org; otherwise https://doi.org/… */
export function paperDoiHref(doi: string | null | undefined): string {
  const d = normalizePaperDoiDisplay(doi);
  if (!d) return "";
  if (/^https?:\/\//i.test(d)) {
    try {
      return new URL(d).href;
    } catch {
      return d;
    }
  }
  if (d.startsWith("10.1145/")) {
    return `https://dl.acm.org/doi/${encodeURI(d)}`;
  }
  return `https://doi.org/${encodeURI(d)}`;
}
