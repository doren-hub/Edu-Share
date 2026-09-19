/** タイトル・ファイル名・DOI の突き合わせ、業界候補の最長一致 */

export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[()[\]{}「」『』【】]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

export function fileStem(filename: string): string {
  return filename.replace(/\.pdf$/i, "").trim();
}

export function fileNameToTitle(filename: string): string {
  return fileStem(filename)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDoi(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  const fromOrg = s.match(/(?:https?:\/\/)?(?:dx\.)?doi\.org\/(10\.[^\s?#]+)/i);
  if (fromOrg?.[1]) s = fromOrg[1];
  if (s.toLowerCase().startsWith("doi:")) s = s.slice(4).trim();
  s = s.replace(/[、,.\s）)'"\u201d]+$/u, "");
  const m = s.match(/\b(10\.\d{4,}\/[^\s)\],.;:<>'"\u201d\u2019]+)/i);
  return (m?.[1] ?? ( /^10\.\d{4,}\/\S+$/i.test(s) ? s : "")).replace(/[.,);:\]]+$/g, "");
}

export function titlesLikelySame(a: string, b: string): boolean {
  const na = normalizeKey(a);
  const nb = normalizeKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 12 && nb.includes(na)) return true;
  if (nb.length >= 12 && na.includes(nb)) return true;
  return false;
}

/** ファイル名そのものや数字IDだけのタイトルは、既存論文との照合に使わない */
export function titleUsableForExistingMatch(title: string, filename: string): boolean {
  const t = title.replace(/\.pdf$/i, "").trim();
  if (!t || t.length < 12) return false;
  const stem = fileStem(filename);
  if (t.toLowerCase() === stem.toLowerCase()) return false;
  if (/^[\d._-]+$/.test(t)) return false;
  return true;
}

export type ExistingPaper = {
  title: string;
  doi: string;
};

export function matchesExistingPaper(
  existing: ExistingPaper[],
  candidate: { title?: string; doi?: string; filename?: string },
): ExistingPaper | null {
  const doi = candidate.doi ? normalizeDoi(candidate.doi) : "";
  if (doi) {
    const hit = existing.find((e) => e.doi && normalizeDoi(e.doi) === doi);
    if (hit) return hit;
  }
  const titles = [candidate.title, candidate.filename ? fileNameToTitle(candidate.filename) : ""]
    .map((t) => t?.trim() ?? "")
    .filter(Boolean);
  for (const t of titles) {
    const hit = existing.find((e) => titlesLikelySame(e.title, t));
    if (hit) return hit;
  }
  return null;
}

export function pickBestOption(options: string[], haystackRaw: string): string {
  const hay = normalizeKey(haystackRaw);
  let best = "";
  let bestLen = -1;
  for (const opt of options) {
    const key = normalizeKey(opt);
    if (!key || key.length < 2) continue;
    if (hay.includes(key) && key.length > bestLen) {
      best = opt;
      bestLen = key.length;
    }
  }
  return best;
}

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  "IT・通信": [
    "software",
    "computer",
    "network",
    "internet",
    "telecom",
    "通信",
    "情報工学",
    "machinelearning",
    "neuralnetwork",
  ],
  "医療・ヘルスケア": ["medical", "health", "clinical", "patient", "医療", "臨床", "ヘルスケア"],
  "金融・保険": ["finance", "bank", "insurance", "金融", "保険"],
  "教育・研究": [
    "arxiv",
    "research",
    "survey",
    "physics",
    "relativity",
    "einstein",
    "schwarzschild",
    "theory",
    "academic",
    "university",
    "論文",
    "研究",
    "教育",
    "gravitation",
    "generalrelativity",
  ],
  "製造業": ["manufactur", "factory", "製造"],
  "エネルギー・インフラ": ["energy", "power grid", "エネルギー", "インフラ"],
  "小売・流通": ["retail", "commerce", "小売", "流通"],
  "メディア・エンタメ": ["media", "entertainment", "メディア", "エンタメ"],
  "公共・非営利": ["government", "nonprofit", "public policy", "公共", "非営利"],
};

export function isOtherIndustryValue(v: string): boolean {
  const t = v.trim();
  return !t || t === "その他" || t.startsWith("その他");
}

/** 論文メタから業界を選ぶ。その他は使わず、学術論文は教育・研究を既定にする */
export function pickPaperIndustry(options: string[], haystackRaw: string): string {
  const usable = options.map((o) => o.trim()).filter((o) => o && !isOtherIndustryValue(o));
  const hay = normalizeKey(haystackRaw);
  let best = "";
  let bestScore = 0;
  for (const opt of usable) {
    const keys = INDUSTRY_KEYWORDS[opt] ?? [];
    let score = 0;
    for (const k of keys) {
      const nk = normalizeKey(k);
      if (nk && hay.includes(nk)) score += nk.length;
    }
    if (hay.includes(normalizeKey(opt))) score += normalizeKey(opt).length + 10;
    if (score > bestScore) {
      best = opt;
      bestScore = score;
    }
  }
  if (best) return best;
  if (usable.includes("教育・研究")) return "教育・研究";
  return usable[0] ?? "";
}
