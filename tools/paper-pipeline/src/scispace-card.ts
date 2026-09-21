/**
 * SciSpace Files カードからメタ情報と TL;DR を別々に取り出す。
 * メタ = タイトル・著者・年・掲載・DOI。TL;DR = 説明本文。混ぜない。
 */

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

const VENUE_HINT =
  /\barxiv\b|\bworkshop\b|\bjournal\b|\btransactions\b|\bproceedings\b|\bconference\b|\bvol\.?\s*\d|\bissue\s*\d|\biclr\b|\bicml\b|\bneurips\b|\bnips\b|\bcvpr\b|\baaai\b|\bacl\b|\bemnlp\b/i;

export function looksLikeVenueLine(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 90) return false;
  if (/^publications of the /i.test(t)) return true;
  if (/^journal of /i.test(t)) return true;
  if (/^proceedings of the /i.test(t)) return true;
  if (/^american journal of /i.test(t)) return true;
  if (/astronomical society of /i.test(t)) return true;
  if (VENUE_HINT.test(t) && !/[.!?。]$/.test(t)) return true;
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

export function sciSpaceTitleLooksLikeChrome(title: string): boolean {
  return Boolean(title.trim() && looksLikeSciSpaceNav(title));
}

export function sciSpaceTldrLooksLikeChrome(tldr: string): boolean {
  return Boolean(tldr.trim() && looksLikeSciSpaceNav(tldr));
}

/** 空の TL;DR は未取得であり、画面の文言ではない。タイトルと TL;DR は別判定 */
export function sciSpaceExtractionLooksLikeChrome(title: string, tldr: string): boolean {
  return sciSpaceTitleLooksLikeChrome(title) || sciSpaceTldrLooksLikeChrome(tldr);
}

/** タイトル・著者・年・掲載・DOI。TL;DR は含めない */
export type SciSpaceCardMeta = {
  title: string;
  yearAuthorLine: string;
  authors: string;
  publicationYear: string;
  venue: string;
  doi: string;
  paste: string;
  /** 説明用。メタの paste には入れない */
  tldr: string;
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

/** Files 行が1行に潰れていても、タイトル・年著者・TL;DR を分けられるようにする */
export function normalizeFilesRowText(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
  t = t.replace(/[^\S\n]+/g, " ");
  t = t.replace(/(\.pdf)\s+/gi, "$1\n");
  t = t.replace(/\s+((?:19|20)\d{2}\s*[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF65])/u, "\n$1");
  t = t.replace(/\s+\b(arXiv|PDF UPLOAD|Uploaded on)\b/g, "\n$1");
  t = t.replace(/\s+\b(The paper|This paper|The study|This study|本研究|本論文)\b/g, "\n$1");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Files 一覧のコピーから、指定 PDF のカードだけを残す（次の .pdf 行で切る） */
export function isolateSciSpaceCardText(raw: string, filename: string): string {
  const lines = linesOf(normalizeFilesRowText(raw));
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
    if (/^(The paper|This paper|The study|This study|本研究|本論文)\b/i.test(s) && s.length > 80) break;
  }
  return out.join("\n");
}

/** Files 行を改行のまま切り出す（タイトル・著者への整形はしない） */
export function isolateSciSpaceCardTextKeepLines(raw: string, filename: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => lineIsThisPdfFilename(l.trim(), filename));
  if (start < 0) {
    const t = raw.trim();
    const stem = filename.replace(/\.pdf$/i, "");
    if (t.includes(filename) || t.includes(stem)) return t.slice(0, 4000);
    return "";
  }
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const s = lines[i]!.trim();
    if (isPdfFilenameLine(s) && !lineNamesThisFile(s, filename)) break;
    out.push(lines[i]!);
  }
  return out.join("\n").replace(/^\n+|\n+$/g, "").slice(0, 4000);
}

/** SciSpace Files の原文（判定・再取得用）。Edu Share のメタ欄へはそのまま入れない */
export function rawFilesCardPaste(raw: string, filename: string): string {
  const isolated = isolateSciSpaceCardTextKeepLines(raw, filename);
  if (!isolated.trim()) return "";
  const stem = filename.replace(/\.pdf$/i, "").toLowerCase();
  const compact = isolated.replace(/\s+/g, " ").trim().toLowerCase();
  if (compact === stem || compact === filename.toLowerCase()) return "";
  if (looksLikeSciSpaceNav(isolated) && isolated.length < 80) return "";
  return preferExpandedAuthorPaste(isolated.slice(0, 4000));
}

/** Edu Share 済みなのに Files 行が無い／タイトル・著者だけに加工されている */
export function needsRawFilesPaste(state: {
  filename: string;
  filesPaste?: string;
  eduShareTestUrl?: string;
}): boolean {
  if (!state.filename || !state.eduShareTestUrl?.trim()) return false;
  return !rawFilesCardPaste(state.filesPaste ?? "", state.filename);
}

/** Files 行が空・省略著者・年著者行無しなら取り直す */
export function needsSciSpaceCardRecapture(state: {
  filename: string;
  filesPaste?: string;
  eduShareTestUrl?: string;
}): boolean {
  if (!state.filename || !state.eduShareTestUrl?.trim()) return false;
  if (needsRawFilesPaste(state)) return true;
  const paste = state.filesPaste ?? "";
  if (filesRowHasTruncatedAuthors(paste)) return true;
  const card = extractSciSpaceCardMeta(paste, state.filename);
  if (isJunkVenueLine(card.venue)) return true;
  if (!card.yearAuthorLine) return true;
  return false;
}

/** SciSpace カードの "...+N More" は著者が省略されている */
export function filesRowHasTruncatedAuthors(paste: string): boolean {
  const t = paste.replace(/\s+/g, " ");
  if (/Show\s*Less/i.test(t)) return false;
  return /(?:\.{2,3}|\u2026)\s*\+\s*\d+\s*More\b/i.test(t);
}

/** Files の "+N More" チップそのもの。年著者セル全体ではない */
export function isFilesAuthorMoreLabel(text: string): boolean {
  return /^(?:\.{2,3}|\u2026)?\s*\+\s*\d+\s*More\s*$/i.test(text.replace(/\s+/g, " ").trim());
}

/** 展開後の DOM に残った "...+N More" を捨て、Show Less 側を残す */
export function preferExpandedAuthorPaste(paste: string): string {
  const lines = paste.replace(/\r\n/g, "\n").split("\n");
  const hasShowLess = lines.some((l) => /Show\s*Less/i.test(l));
  if (!hasShowLess) return paste;
  return lines
    .map((l) => l.replace(/(?:\.{2,3}|\u2026)\s*\+\s*\d+\s*More\b/gi, "").replace(/[ \t]{2,}/g, " "))
    .filter((l) => !/^\s*\+\s*\d+\s*More\s*$/i.test(l.trim()))
    .join("\n");
}

export function containsForeignPdf(raw: string, filename: string): boolean {
  const name = filename.replace(/\.pdf$/i, "").toLowerCase();
  return linesOf(raw).some((l) => {
    if (!isPdfFilenameLine(l)) return false;
    const stem = l.replace(/\.pdf$/i, "").trim().toLowerCase();
    return stem !== name && !lineNamesThisFile(l, filename);
  });
}

export function replaceYearAuthorLine(paste: string, yearAuthorLine: string): string {
  const line = yearAuthorLine.trim();
  if (!line) return paste;
  const lines = paste.replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex((l) => Boolean(parseYearAuthor(l)) || filesRowHasTruncatedAuthors(l));
  if (idx >= 0) {
    lines[idx] = line;
    return lines.join("\n");
  }
  const fileIdx = lines.findIndex((l) => /\.pdf$/i.test(l.trim()));
  lines.splice((fileIdx >= 0 ? fileIdx : 0) + 2, 0, line);
  return lines.join("\n");
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

function isJunkVenueLine(s: string): boolean {
  return /^(null|undefined|none|n\/a|-)$/i.test(s.trim());
}

function pickVenue(lines: string[], filename: string, title: string): string {
  const skip = new Set([filename, title].filter(Boolean));
  const leftover: string[] = [];
  for (const s of lines) {
    if (skip.has(s) || looksLikeSciSpaceNav(s) || parseYearAuthor(s)) continue;
    if (/\.pdf$/i.test(s)) continue;
    if (/^(this paper|the paper|本研究|本論文)\b/i.test(s)) continue;
    if (isJunkVenueLine(s)) continue;
    if (s.length > 80) continue;
    if (isTldrBodyLine(s)) continue;
    if (VENUE_HINT.test(s) || looksLikeVenueLine(s)) return s;
    if (looksLikeCitationTitle(s) && s.length > 60) continue;
    leftover.push(s);
  }
  return leftover[0] ?? "";
}

const TLDR_OPENER =
  /\b(?:this paper|the paper|本研究|本論文|examines|presents|addresses|explores|discusses|investigates|proposes|we (?:present|study|show|investigate))\b/i;

/** Files 右列の TL;DR 本文。メタ情報（タイトル・著者・年・掲載・DOI）ではない */
export function isTldrBodyLine(s: string): boolean {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t || t.length < 80) return false;
  if (/\.pdf$/i.test(t)) return false;
  if (looksLikeSciSpaceNav(t)) return false;
  if (parseYearAuthor(t)) return false;
  if (looksLikeVenueLine(t)) return false;
  if (looksLikeCitationTitle(t)) return false;
  if (TLDR_OPENER.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 18 && /[.!?。]$/.test(t);
}

/** Edu Share メタ欄用。タイトル・年著者行・掲載を原文のまま。DOI と TL;DR は入れない */
export function metadataPasteFromCard(
  card: Pick<SciSpaceCardMeta, "title" | "yearAuthorLine" | "venue">,
  filename: string,
): string {
  const title =
    card.title && !titleLooksLikeFilename(card.title, filename) ? card.title.trim() : "";
  return [title, card.yearAuthorLine, card.venue]
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Edu Share のメタ貼り付け欄。Files 原文や TL;DR 本文は入れない */
export function eduShareSciSpaceMetadataPaste(paste: string, filename: string): string {
  const card = extractSciSpaceCardMeta(paste, filename);
  const out = metadataPasteFromCard(card, filename);
  if (!out) return "";
  if (!card.yearAuthorLine && titleLooksLikeFilename(card.title, filename)) return "";
  if (isTldrBodyLine(out) && !card.yearAuthorLine && !card.venue) return "";
  return out;
}

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
  t = t.replace(/[\s\u00a0]+\d+(?:\s*,\s*\d+|\s+\d+)*\s*\.?$/u, "");
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
  const meta = {
    title,
    yearAuthorLine: yaLine,
    authors: ya?.authors ?? "",
    publicationYear: ya?.year ?? "",
    venue,
    doi,
  };
  return {
    ...meta,
    tldr,
    paste: metadataPasteFromCard(meta, filename),
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
