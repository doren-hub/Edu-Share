/** SciSpace Files カードから、Edu Share に貼れるメタと TL;DR だけを取り出す */

const MIDDLE_DOT = String.raw`[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF65]`;
const YEAR_AUTHOR = new RegExp(`^((?:19|20)\\d{2})\\s*${MIDDLE_DOT}\\s*(.+)$`, "u");

const NAV =
  /^(home|agent gallery|templates|files(\s*\(\d+\))?|notebooks(\s*\(\d+\))?|chats(\s*\(\d+\))?|sort|export|share|upload pdfs|pdf upload|column settings|untitled folder|tools|lite|standard quality|en|tl;dr)$/i;

export function looksLikeSciSpaceNav(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (NAV.test(t)) return true;
  if (/^files\s*\(/i.test(t)) return true;
  if (/^uploaded on\b/i.test(t)) return true;
  if (/^pdf upload$/i.test(t)) return true;
  if (/^column settings$/i.test(t)) return true;
  if (/^add custom column$/i.test(t)) return true;
  if (/^create your own custom column/i.test(t)) return true;
  return false;
}

export type SciSpaceCardMeta = {
  title: string;
  yearAuthorLine: string;
  authors: string;
  publicationYear: string;
  venue: string;
  tldr: string;
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

/** Files 一覧のコピーから、指定 PDF のカードだけを残す（次の .pdf 行で切る） */
export function isolateSciSpaceCardText(raw: string, filename: string): string {
  const lines = linesOf(raw);
  const start = lines.findIndex((l) => lineNamesThisFile(l, filename));
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

function parseYearAuthor(line: string): { year: string; authors: string } | null {
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
        !parseYearAuthor(s) &&
        !/^(this paper|the paper|本研究|本論文)\b/i.test(s),
    ) ?? ""
  );
}

function pickVenue(lines: string[], filename: string, title: string): string {
  const skip = new Set([filename, title].filter(Boolean));
  for (const s of lines) {
    if (skip.has(s) || looksLikeSciSpaceNav(s) || parseYearAuthor(s)) continue;
    if (/\.pdf$/i.test(s)) continue;
    if (/^(this paper|the paper|本研究|本論文)\b/i.test(s)) continue;
    if (s.length > 80) continue;
    if (/arxiv|journal|transactions|volume|issue|proceedings|conference/i.test(s)) return s;
  }
  return "";
}

function pickTldr(text: string, lines: string[]): string {
  const fromLine = lines.find(
    (p) =>
      p.length > 80 &&
      /this paper|the paper|本研究|本論文|examines|presents|addresses/i.test(p) &&
      !looksLikeSciSpaceNav(p) &&
      !/^home\b/i.test(p),
  );
  if (fromLine && !/agent gallery/i.test(fromLine)) {
    return stripTldrSnippetNumbers(fromLine.slice(0, 1500));
  }

  const m = text.match(
    /\b((?:This paper|The paper|本研究[はが]|本論文[はが])[\s\S]{40,1200}?)(?:\n\s*\n|Column Settings|$)/i,
  );
  if (m?.[1]) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (t.length > 80 && !/agent gallery/i.test(t)) return stripTldrSnippetNumbers(t.slice(0, 1500));
  }
  return "";
}

/** SciSpace TL;DR 末尾の出典 snippet 番号（" 1" / " [1]" / 連続番号）を除く */
export function stripTldrSnippetNumbers(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(/[\s\u00a0]*\[\d+(?:\s*,\s*\d+)*\]\.?$/u, "");
  t = t.replace(/[\s\u00a0\u00b9\u00b2\u00b3\u2070-\u2079]+$/u, "");
  t = t.replace(/[\s\u00a0]+\d+(?:\s*,\s*\d+|\s+\d+)*\.?$/u, "");
  t = t.replace(/\s+([.!?])$/u, "$1");
  if (t && !/[.!?。！？]$/.test(t)) t = `${t}.`;
  return t.trim();
}

export function extractSciSpaceCardMeta(raw: string, filename: string): SciSpaceCardMeta {
  const isolated = isolateSciSpaceCardText(raw, filename);
  const lines = linesOf(isolated);
  const title = pickTitle(lines, filename);
  const yaLine = lines.find((l) => parseYearAuthor(l)) ?? "";
  const ya = yaLine ? parseYearAuthor(yaLine) : null;
  const venue = pickVenue(lines, filename, title);
  const tldr = pickTldr(isolated, lines);
  const paste = [title, yaLine, venue].filter(Boolean).join("\n");
  return {
    title,
    yearAuthorLine: yaLine,
    authors: ya?.authors ?? "",
    publicationYear: ya?.year ?? "",
    venue,
    tldr,
    paste,
  };
}
