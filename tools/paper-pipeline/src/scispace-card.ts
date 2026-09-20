/** SciSpace Files カードから、Edu Share に貼れるメタと TL;DR だけを取り出す */

const MIDDLE_DOT = String.raw`[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF65]`;
const YEAR_AUTHOR = new RegExp(`^((?:19|20)\\d{2})\\s*${MIDDLE_DOT}\\s*(.+)$`, "u");

const NAV =
  /^(home|agent gallery|templates|files(\s*\(\d+\))?|notebooks(\s*\(\d+\))?|chats(\s*\(\d+\))?|sort|export|share|upload pdfs|pdf upload|column settings|untitled folder|tools|lite|standard quality|en|tl;dr)$/i;

export function looksLikeCitationTitle(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/\d+,\s*\d+\s*[—\-–]\s*\d+\s*\(\d{4}\)/.test(t)) return true;
  if (/^commun\.\s/i.test(t)) return true;
  if (/^[\s,]*\d+[—–-]\d+\s*\(\d{4}\)\s*$/.test(t)) return true;
  if (
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/read pdf in full screen/i.test(t)) return true;
  if (/©/.test(t) || /springer-verlag/i.test(t)) return true;
  return false;
}

export function looksLikeVenueLine(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 90) return false;
  if (/^publications of the /i.test(t)) return true;
  if (/^journal of /i.test(t)) return true;
  if (/^proceedings of the /i.test(t)) return true;
  if (/^american journal of /i.test(t)) return true;
  if (/astronomical society of /i.test(t)) return true;
  return false;
}

const SCISPACE_PROMPTS = [
  /explain math/i,
  /generate summary of this paper/i,
  /find related papers/i,
  /literature survey of this paper/i,
  /explain the practical implications of this paper/i,
  /explain abstract of this paper/i,
  /results of the paper/i,
  /conclusions from the paper/i,
  /what are the contributions of this paper/i,
  /summarise introduction of this paper/i,
  /methods used in this paper/i,
  /what data has been used in this paper/i,
  /limitations of this paper/i,
  /future works suggested in this paper/i,
  /^chat with pdf$/i,
  /read pdf in full screen/i,
];

export function looksLikeSciSpaceNav(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (NAV.test(t)) return true;
  if (/^files\s*\(/i.test(t)) return true;
  if (/^uploaded on\b/i.test(t)) return true;
  if (/^pdf upload$/i.test(t)) return true;
  if (/\bpdf upload\b/i.test(t) && /\buploaded on\b/i.test(t)) return true;
  if (/^column settings$/i.test(t)) return true;
  if (/^add custom column$/i.test(t)) return true;
  if (/^create your own custom column/i.test(t)) return true;
  const promptHits = SCISPACE_PROMPTS.filter((re) => re.test(t)).length;
  if (promptHits >= 2) return true;
  if (t.length > 240) return false;
  return promptHits >= 1;
}

/** 空の TL;DR は未取得であり、画面の文言ではない */
export function sciSpaceExtractionLooksLikeChrome(title: string, tldr: string): boolean {
  if (title.trim() && looksLikeSciSpaceNav(title)) return true;
  if (tldr.trim() && looksLikeSciSpaceNav(tldr)) return true;
  return false;
}

export type SciSpaceCardMeta = {
  title: string;
  yearAuthorLine: string;
  authors: string;
  publicationYear: string;
  venue: string;
  tldr: string;
  doi: string;
  paste: string;
};

function linesOf(text: string): string[] {
  return text
    .split(/\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isPdfFilenameLine(s: string): boolean {
  return /\.pdf$/i.test(s.trim());
}

function lineNamesThisFile(s: string, filename: string): boolean {
  const t = s.trim();
  const name = filename.trim();
  const stem = name.replace(/\.pdf$/i, "");
  if (!t) return false;
  if (t === name || t === stem) return true;
  if (t.endsWith(name) || t.endsWith(`${stem}.pdf`)) return true;
  return false;
}

/** 検索欄の stem だけでは切らない。カード先頭は `.pdf` 行にする */
function lineIsThisPdfFilename(s: string, filename: string): boolean {
  const t = s.trim();
  const name = filename.trim();
  const stem = name.replace(/\.pdf$/i, "");
  if (!t) return false;
  if (t === name) return true;
  if (t.endsWith(name) || t.endsWith(`${stem}.pdf`)) return true;
  return false;
}

/** Files 一覧のコピーから、指定 PDF のカードだけを残す（次の .pdf 行で切る） */
export function isolateSciSpaceCardText(raw: string, filename: string): string {
  const lines = linesOf(raw);
  const start = lines.findIndex((l) => lineIsThisPdfFilename(l, filename));
  if (start < 0) {
    if (lines.some(isPdfFilenameLine)) return "";
    return lines.join("\n");
  }
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const s = lines[i]!;
    if (isPdfFilenameLine(s) && !lineNamesThisFile(s, filename)) break;
    out.push(s);
  }
  return out.join("\n");
}

export function containsForeignPdf(raw: string, filename: string): boolean {
  const name = filename.replace(/\.pdf$/i, "").toLowerCase();
  return linesOf(raw).some((l) => {
    if (!isPdfFilenameLine(l)) return false;
    const stem = l.replace(/\.pdf$/i, "").trim().toLowerCase();
    return stem !== name && !lineNamesThisFile(l, filename);
  });
}

export function parseYearAuthor(line: string): { year: string; authors: string } | null {
  const m = line.trim().match(YEAR_AUTHOR);
  if (!m) return null;
  const authors = m[2]!.replace(/^DOI\s*[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF65]\s*/iu, "").trim();
  if (!authors) return null;
  return { year: m[1]!, authors };
}

function pickTitle(lines: string[], filename: string): string {
  const i = lines.findIndex((l) => l.includes(filename));
  const after = i >= 0 ? lines.slice(i + 1) : lines;
  return (
    after.find(
      (s) =>
        s.length > 12 &&
        !/\.pdf$/i.test(s) &&
        !looksLikeSciSpaceNav(s) &&
        !looksLikeCitationTitle(s) &&
        !looksLikeVenueLine(s) &&
        !parseYearAuthor(s) &&
        !/^arxiv:/i.test(s) &&
        !/^(this paper|the paper|本研究|本論文)\b/i.test(s),
    ) ?? ""
  );
}

function pickVenue(lines: string[], filename: string, title: string): string {
  const skip = new Set([filename, title].filter(Boolean));
  for (const s of lines) {
    if (skip.has(s) || looksLikeSciSpaceNav(s) || looksLikeCitationTitle(s) || parseYearAuthor(s)) continue;
    if (/\.pdf$/i.test(s)) continue;
    if (/^(this paper|the paper|本研究|本論文)\b/i.test(s)) continue;
    if (s.length > 80) continue;
    if (/\barxiv\b|journal|transactions|\bvol\.?\s*\d|\bissue\s*\d|proceedings|conference/i.test(s)) return s;
  }
  return "";
}

const TLDR_OPENER =
  /\b(?:this paper|the paper|本研究|本論文|examines|presents|addresses|explores|discusses|investigates|reviews|proposes|we (?:present|study|show|investigate))\b/i;

function pickTldr(text: string, lines: string[], title: string): string {
  const fromLine = lines.find(
    (p) =>
      p.length > 80 &&
      TLDR_OPENER.test(p) &&
      !looksLikeSciSpaceNav(p) &&
      !parseYearAuthor(p) &&
      !/^home\b/i.test(p),
  );
  if (fromLine && !/agent gallery/i.test(fromLine) && !looksLikeSciSpaceNav(fromLine)) {
    return stripTldrSnippetNumbers(fromLine.slice(0, 1500));
  }

  const m = text.match(
    /\b((?:This paper|The paper|本研究[はが]|本論文[はが])[\s\S]{40,1200}?)(?:\n\s*\n|Column Settings|$)/i,
  );
  if (m?.[1]) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (t.length > 80 && !/agent gallery/i.test(t)) return stripTldrSnippetNumbers(t.slice(0, 1500));
  }

  const fallback = lines
    .filter(
      (p) =>
        p.length > 100 &&
        p !== title &&
        !isPdfFilenameLine(p) &&
        !looksLikeSciSpaceNav(p) &&
        !looksLikeCitationTitle(p) &&
        !parseYearAuthor(p) &&
        !/^[a-z]/.test(p) &&
        !/^uploaded on\b/i.test(p) &&
        !/^pdf upload$/i.test(p),
    )
    .sort((a, b) => b.length - a.length)[0];
  if (fallback && !/agent gallery/i.test(fallback) && !looksLikeSciSpaceNav(fallback)) {
    return stripTldrSnippetNumbers(fallback.slice(0, 1500));
  }
  return "";
}

const DOI_TOKEN = /\b(10\.\d{4,}\/[^\s)\]<>"']+)/i;

export function doiFromHrefOrText(raw: string): string {
  const href = raw.match(/https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,}\/[^\s)\]<>"'?#]+)/i);
  if (href?.[1]) {
    return href[1].replace(/[.,;]+$/g, "");
  }
  const m = raw.match(DOI_TOKEN);
  if (!m?.[1]) return "";
  const doi = m[1].replace(/[.,;]+$/g, "");
  if (/^10\.\d{4,}\/?$/i.test(doi)) return "";
  return doi;
}

/** SciSpace TL;DR 末尾の出典 snippet 番号（" 1" / " [1]" / 連続番号）を除く */
export function stripTldrSnippetNumbers(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(/[\s\u00a0]*\[\d+(?:\s*,\s*\d+)*\]\.?$/u, "");
  t = t.replace(/[\s\u00a0\u00b9\u00b2\u00b3\u2070-\u2079]+$/u, "");
  t = t.replace(/[\s\u00a0]+\d+(?:\s*,\s*\d+|\s+\d+)*\.?$/u, "");
  t = t.replace(/\s+([.!?])$/u, "$1");
  if (t && !/[.!?。！？]$/.test(t) && !/[-–—,;:]$/.test(t)) t = `${t}.`;
  return t.trim();
}

/** 途中切れや画面文言は SciSpace 完了判定に使わない */
export function tldrUsable(s: string): boolean {
  const t = stripTldrSnippetNumbers(s);
  if (t.length < 120) return false;
  if (looksLikeSciSpaceNav(t)) return false;
  if (looksLikeCitationTitle(t)) return false;
  if (/^[a-z]/.test(t)) return false;
  if (/[-–—,;:]\.?$/.test(t)) return false;
  if (/\([eE]\.g\.[^)]*$/.test(t)) return false;
  return true;
}

/** Edu Share の説明欄に入れてよい本文（短い途中切れは除外） */
export function descriptionUsable(s: string): boolean {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length < 80) return false;
  if (looksLikeSciSpaceNav(t)) return false;
  if (t.length < 120) {
    if (looksLikeCitationTitle(t)) return false;
    if (/[-–—,;:]\.?$/.test(t)) return false;
    if (/\([eE]\.g\.[^)]*$/.test(t)) return false;
  }
  return true;
}

export function pickAbstractSection(text: string): string {
  const m = text.match(
    /(?:^|\n)\s*(?:Abstract|TL;DR|TLDR|要旨)\s*[:.\n]+\s*([\s\S]{80,2500}?)(?=\n\s*(?:References|Introduction|Keywords|Key words|Column Settings|1\.\s)|$)/i,
  );
  const t = (m?.[1] ?? "").replace(/\s+/g, " ").trim();
  return tldrUsable(t) ? t : "";
}

export function extractSciSpaceCardMeta(raw: string, filename: string): SciSpaceCardMeta {
  const isolated = isolateSciSpaceCardText(raw, filename);
  const lines = linesOf(isolated);
  const title = pickTitle(lines, filename);
  const yaLine = lines.find((l) => parseYearAuthor(l)) ?? "";
  const ya = yaLine ? parseYearAuthor(yaLine) : null;
  const venue = pickVenue(lines, filename, title);
  const tldr = pickAbstractSection(isolated) || pickTldr(isolated, lines, title);
  const doi = doiFromHrefOrText(isolated);
  const paste = [title, yaLine, venue].filter(Boolean).join("\n");
  return {
    title,
    yearAuthorLine: yaLine,
    authors: ya?.authors ?? "",
    publicationYear: ya?.year ?? "",
    venue,
    tldr,
    doi,
    paste,
  };
}

export function titleLooksLikeFilename(title: string, filename: string): boolean {
  const stem = filename.replace(/\.pdf$/i, "").toLowerCase();
  const titleKey = title.replace(/\.pdf$/i, "").trim().toLowerCase();
  if (!titleKey || titleKey === stem || titleKey === filename.toLowerCase()) return true;
  if (stem && titleKey.includes(stem) && /^arxiv:/i.test(titleKey)) return true;
  return false;
}

/** Files 行候補から、右列 TL;DR 付きのカードを優先して選ぶ */
export function scoreSciSpaceCardCandidate(raw: string, filename: string): number {
  const isolated = isolateSciSpaceCardText(raw, filename);
  if (!isolated.trim()) return Number.NEGATIVE_INFINITY;
  const card = extractSciSpaceCardMeta(raw, filename);
  let s = 0;
  if (card.title && !titleLooksLikeFilename(card.title, filename)) s += 40;
  if (card.authors) s += 25;
  if (card.publicationYear) s += 15;
  if (card.venue) s += 15;
  if (card.tldr.length > 80) s += 80;
  if (card.doi) s += 20;
  if (containsForeignPdf(isolated, filename)) s -= 80;
  if (raw.length < 80) s -= 30;
  if (raw.length > 3500) s -= 20;
  return s;
}

export function pickBestSciSpaceCardText(candidates: string[], filename: string): string {
  let best = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  const seen = new Set<string>();
  for (const raw of candidates) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const s = scoreSciSpaceCardCandidate(t, filename);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return Number.isFinite(bestScore) ? best : "";
}
