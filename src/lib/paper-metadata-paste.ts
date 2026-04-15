/**
 * SciSpace 等からコピーした「タイトル / DOI / 著者 / 年-掲載」のブロックを解析する。
 */

export type ParsedPaperMetadataPaste = {
  title: string;
  publicationYear: string;
  doi: string;
  authors: string;
  venue: string;
};

/** ASCII ハイフン・マイナス・en/em dash 等（年-掲載・UI ノイズ除去用） */
const UNICODE_DASH = String.raw`[\u002D\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]`;

/** 行末の「年＋ダッシュ＋掲載」 */
const YEAR_VENUE_AT_EOL = new RegExp(
  `((?:19|20)\\d{2})\\s*${UNICODE_DASH}\\s*([^\\n\\r]+?)(?=\\s*$)`,
  "u",
);

function stripInvisible(s: string): string {
  return s
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function stripUiNoise(line: string): string {
  let t = line.trim();
  t = t.replace(
    new RegExp(`\\s*${UNICODE_DASH}\\s*Show less\\s*$`, "iu"),
    "",
  );
  t = t.replace(/\s*Show less\s*$/iu, "");
  t = t.replace(/\s*Show more\s*$/iu, "");
  return t.trim();
}

function normalizeDoi(s: string): string {
  let t = stripInvisible(s)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  t = t.replace(/[\s\u00a0]+$/, "");
  t = t.replace(/[.,);:\]]+$/g, "");
  return t;
}

function isDoiToken(t: string): boolean {
  if (!t) return false;
  return /^10\.\d{4,}\/\S+$/i.test(t);
}

function isDoiLine(s: string): boolean {
  return isDoiToken(normalizeDoi(s));
}

function parseYearVenue(s: string): { year: string; venue: string } | null {
  const t = stripInvisible(s);
  const m = t.match(new RegExp(`^(\\d{4})\\s*${UNICODE_DASH}\\s*(.+)$`, "u"));
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1900 || y > 2100) return null;
  const venue = m[2].trim();
  if (!venue) return null;
  return { year: m[1], venue };
}

function isYearVenueLine(s: string): boolean {
  return parseYearVenue(s) !== null;
}

function looksLikeAuthorLine(s: string): boolean {
  const t = stripUiNoise(s);
  if (t.length < 12) return false;
  if (/^Title\s*[:：]/iu.test(t)) return false;
  if (isDoiLine(t)) return false;
  if (isYearVenueLine(t)) return false;
  return t.includes(",") || /\s+and\s+/i.test(t);
}

/** 改行が少ないコピー用: DOI・年の前に改行を補う */
function breakoutLogicalLines(raw: string): string {
  let s = raw.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
  s = s.replace(/([^\n])([\s\u00a0]+)(?=10\.\d{4,}\/\S)/gi, "$1\n");
  s = s.replace(
    /([\p{L}\p{N},])([\s\u00a0]{2,})((?:19|20)\d{2}\s*\p{Pd})/giu,
    "$1\n$3",
  );
  return s;
}

const DOI_ANYWHERE = /\b(10\.\d{4,}\/[^\s)\],.;:<>'"\u201d\u2019]+)/gi;

function extractDoiFromText(text: string): string {
  const matches = [...text.matchAll(DOI_ANYWHERE)];
  for (const m of matches) {
    const cand = normalizeDoi(m[1] ?? "");
    if (isDoiToken(cand)) return cand;
  }
  return "";
}

function extractYearVenueFromText(text: string): { year: string; venue: string } | null {
  const lines = text.split("\n").map((l) => stripInvisible(l));
  for (let i = lines.length - 1; i >= 0; i--) {
    const yv = parseYearVenue(lines[i]);
    if (yv) return yv;
  }
  const t = stripInvisible(text);
  const tm = t.match(YEAR_VENUE_AT_EOL);
  if (tm) return parseYearVenue(`${tm[1]}-${tm[2].trim()}`);
  return null;
}

function parseTitlePrefix(line: string): string | null {
  const m = line.match(/^Title\s*[:：]\s*(.+)$/iu);
  return m ? m[1].trim() : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** DOI の直後〜末尾の「年-掲載」までを著者候補として切り出し（1行貼り付け対策） */
function extractAuthorAfterDoi(raw: string, doi: string): string {
  if (!doi) return "";
  const parts = raw.split(new RegExp(escapeRegExp(doi), "i"));
  if (parts.length < 2) return "";
  let slice = parts.slice(1).join(doi);
  slice = slice.replace(YEAR_VENUE_AT_EOL, "").trim();
  return stripUiNoise(stripInvisible(slice));
}

/**
 * 貼り付けテキストから論文メタの各部分を取り出す。取れない項目は空文字。
 */
export function parsePaperMetadataPaste(raw: string): ParsedPaperMetadataPaste {
  const expanded = breakoutLogicalLines(stripInvisible(raw));
  const lines = expanded
    .split(/\n/)
    .map((l) => stripUiNoise(l))
    .map((l) => stripInvisible(l))
    .filter((l) => l.length > 0);

  let title = "";
  let doi = "";
  let authors = "";
  let venue = "";
  let publicationYear = "";

  const used = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromTitle = parseTitlePrefix(line);
    if (fromTitle !== null) {
      title = fromTitle;
      used.add(i);
      continue;
    }
    if (isDoiLine(line)) {
      doi = normalizeDoi(line);
      used.add(i);
      continue;
    }
    const labeledYear = line.match(
      /^(?:published|publication\s*year|year|公開年?|掲載年?|発表年?)\s*[:：]?\s*((?:19|20)\d{2})\s*$/iu,
    );
    if (labeledYear) {
      publicationYear = labeledYear[1];
      used.add(i);
      continue;
    }
    const yv = parseYearVenue(line);
    if (yv) {
      publicationYear = yv.year;
      venue = yv.venue;
      used.add(i);
      continue;
    }
    if (/^(?:19|20)\d{2}$/.test(line)) {
      publicationYear = line;
      used.add(i);
      continue;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const line = lines[i];
    if (looksLikeAuthorLine(line)) {
      authors = stripUiNoise(line);
      used.add(i);
      break;
    }
  }

  if (!title) {
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      const line = lines[i];
      if (line.length > 8 && !isDoiLine(line) && !isYearVenueLine(line)) {
        title = line;
        used.add(i);
        break;
      }
    }
  }

  if (!doi) {
    const fromFull = extractDoiFromText(raw);
    if (fromFull) doi = fromFull;
  }

  if (!publicationYear || !venue) {
    const yv = extractYearVenueFromText(expanded) ?? extractYearVenueFromText(raw);
    if (yv) {
      if (!publicationYear) publicationYear = yv.year;
      if (!venue) venue = yv.venue;
    }
  }

  if (title) {
    const d = doi || extractDoiFromText(title);
    if (d) {
      const idx = title.indexOf(d);
      if (idx >= 0) {
        title = stripInvisible(title.slice(0, idx)).replace(/[\s,;]+$/g, "");
        if (!doi) doi = d;
      }
    }
    const yvTail = parseYearVenue(title);
    if (yvTail) {
      title = stripInvisible(
        title.replace(
          new RegExp(
            `${yvTail.year}\\s*${UNICODE_DASH}\\s*${escapeRegExp(yvTail.venue)}`,
            "iu",
          ),
          "",
        ),
      ).replace(/[\s,;]+$/g, "");
      if (!publicationYear) publicationYear = yvTail.year;
      if (!venue) venue = yvTail.venue;
    }
  }

  if (!authors && doi) {
    const tail = extractAuthorAfterDoi(raw, doi);
    if (tail && (tail.includes(",") || /\s+and\s+/i.test(tail))) authors = tail;
  }

  return { title, publicationYear, doi, authors, venue };
}

export function buildDescriptionFromParsedPaste(
  p: ParsedPaperMetadataPaste,
): string {
  const parts: string[] = [];
  if (p.venue) parts.push(`掲載: ${p.venue}`);
  if (p.doi) parts.push(`DOI: ${p.doi}`);
  if (p.authors) parts.push(`著者: ${p.authors}`);
  return parts.join("\n");
}
