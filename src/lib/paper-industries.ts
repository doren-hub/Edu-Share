export const MAX_INDUSTRIES = 10;

/** DB / PostgREST の unknown を業界配列に正規化（industries 優先、無ければ旧 industry 単体） */
export function normalizePaperIndustriesFromDb(
  raw: unknown,
  legacyIndustry?: string | null,
): string[] {
  let out: string[] = [];
  if (Array.isArray(raw)) {
    out = raw.map((x) => String(x).trim()).filter((s) => s.length > 0);
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const j = JSON.parse(raw) as unknown;
      if (Array.isArray(j)) {
        out = j.map((x) => String(x).trim()).filter((s) => s.length > 0);
      }
    } catch {
      out = [raw.trim()];
    }
  }
  if (out.length === 0) {
    const l = (legacyIndustry ?? "").trim();
    if (l) out = [l];
  }
  return out;
}

/** 表示用（読点区切り。無ければ空文字） */
export function displayPaperIndustries(
  raw: unknown,
  legacyIndustry?: string | null,
): string {
  return normalizePaperIndustriesFromDb(raw, legacyIndustry).join("、");
}
