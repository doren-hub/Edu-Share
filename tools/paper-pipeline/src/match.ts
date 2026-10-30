/** タイトル・ファイル名・DOI の突き合わせ、業界候補の最長一致 */

import { isDummySciSpacePaste, looksLikeCitationTitle, looksLikeVenueLine, tldrUsable } from "./scispace-card.ts";

export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
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
  if (looksLikeCitationTitle(t)) return false;
  if (looksLikeVenueLine(t)) return false;
  if (isDummySciSpacePaste(t)) return false;
  return true;
}

/** タイトルがファイル名のまま、または Files 原文が空なら SciSpace メタが未入り。TL;DR は見ない */
export function sciSpaceCardMetaIncomplete(state: {
  title: string;
  filename: string;
  filesPaste: string;
}): boolean {
  if (!titleUsableForExistingMatch(state.title, state.filename)) return true;
  if (!state.filesPaste.trim()) return true;
  return false;
}

/** TL;DR（説明）が未入り。メタ情報とは別 */
export function sciSpaceTldrIncomplete(tldr: string): boolean {
  return !tldrUsable(tldr);
}

export type ExistingPaper = {
  title: string;
  doi: string;
  filename?: string;
  id?: string;
  url?: string;
  paperDir?: string;
};

/** 論文 PDF の名称。パス・拡張子の有無・大小文字は同一とみなす */
export function normalizePdfFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (!base) return "";
  const lower = base.toLowerCase();
  return lower.endsWith(".pdf") ? lower : `${lower}.pdf`;
}

/** 既存論文かどうかは PDF ファイル名だけで判定する（タイトル・DOI は見ない） */
export function matchesExistingPaper(
  existing: ExistingPaper[],
  candidate: { title?: string; doi?: string; filename?: string },
): ExistingPaper | null {
  const want = candidate.filename ? normalizePdfFilename(candidate.filename) : "";
  if (!want) return null;
  return (
    existing.find((e) => e.filename && normalizePdfFilename(e.filename) === want) ?? null
  );
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
  "AI・データ": [
    "AI",
    "artificial intelligence",
    "machine learning",
    "neural network",
    "deep learning",
    "data science",
    "LLM",
    "large language model",
    "transformer",
    "generative AI",
    "computer vision",
    "reinforcement learning",
    "人工知能",
    "機械学習",
    "深層学習",
    "データ分析",
    "大規模言語モデル",
  ],
  "IT・通信": [
    "software",
    "computer",
    "network",
    "internet",
    "telecom",
    "SmartNIC",
    "browser",
    "datacenter",
    "通信",
    "情報工学",
  ],
  "半導体・電子デバイス": [
    "semiconductor",
    "photonic",
    "display",
    "electronic device",
    "transistor",
    "FET",
    "MOSFET",
    "CMOS",
    "nanosheet",
    "gate-all-around",
    "GAA",
    "chiplet",
    "lithography",
    "wafer",
    "半導体",
    "光電融合",
    "電子デバイス",
    "電子ペーパー",
    "トランジスタ",
    "ナノシート",
  ],
  "エネルギー・資源": ["energy", "power grid", "renewable", "エネルギー", "資源", "電力"],
  "宇宙・天文": [
    "astronom",
    "cosmolog",
    "galaxy",
    "universe",
    "spacecraft",
    "astrophysic",
    "black hole",
    "telescope",
    "planetary",
    "exoplanet",
    "宇宙",
    "天文",
    "銀河",
    "ブラックホール",
  ],
  // theory / academic / 論文 / 研究 など、分野を特定しない語は含めない。
  "基礎科学（物理・数学）": [
    "physics",
    "mathematic",
    "relativity",
    "einstein",
    "schwarzschild",
    "gravitation",
    "quantum",
    "equation",
    "algebra",
    "geometry",
    "thermodynamic",
    "particle physics",
    "物理",
    "数学",
    "相対論",
    "量子",
    "方程式",
  ],
  "医療・ライフサイエンス": ["medical", "health", "clinical", "patient", "biolog", "genom", "医療", "臨床", "生命科学", "生物", "遺伝子"],
  "農業・食品": ["agricultur", "crop", "farm", "food", "農業", "作物", "圃場", "食品"],
  "ロボティクス": ["robot", "ROS", "path tracking", "pure pursuit", "kinematics", "SLAM", "localization", "ロボット"],
  "建設・インフラ": ["construction", "civil engineering", "infrastructure", "建設", "土木", "インフラ"],
  "経済・金融": ["econom", "finance", "financial", "bank", "insurance", "経済", "金融", "保険"],
  "言語・教育": ["linguistic", "language", "education", "teaching", "言語", "教育", "授業"],
};

const INDUSTRY_WORD_PATTERNS: Record<string, RegExp> = {
  AI: /\bAI\b/i,
  LLM: /\bLLMs?\b/i,
  FET: /\bFETs?\b/i,
  GAA: /\bGAAs?\b/i,
  ROS: /\bROS\b/i,
  SLAM: /\bSLAM\b/i,
  crop: /\bcrops?\b/i,
  farm: /\bfarm\w*\b/i,
};

export function isOtherIndustryValue(v: string): boolean {
  const t = v.trim();
  return !t || t === "その他" || t.startsWith("その他");
}

/** 新しい選択肢から最も一致する業界を選ぶ。分野の根拠がなければ未選択にする。 */
export function pickPaperIndustry(options: string[], haystackRaw: string): string {
  const usable = options.map((o) => o.trim()).filter((o) => Object.hasOwn(INDUSTRY_KEYWORDS, o));
  const hay = normalizeKey(haystackRaw);
  let best = "";
  let bestScore = 0;
  for (const opt of usable) {
    const keys = INDUSTRY_KEYWORDS[opt] ?? [];
    let score = 0;
    for (const k of keys) {
      const nk = normalizeKey(k);
      // 略語や crop が cross / mail / microprocessor の一部に一致するのを避ける。
      const wordPattern = INDUSTRY_WORD_PATTERNS[k];
      const matches = wordPattern ? wordPattern.test(haystackRaw) : nk && hay.includes(nk);
      if (matches) score += nk.length;
    }
    if (hay.includes(normalizeKey(opt))) score += normalizeKey(opt).length + 10;
    if (score > bestScore) {
      best = opt;
      bestScore = score;
    }
  }
  if (best) return best;
  return "";
}
