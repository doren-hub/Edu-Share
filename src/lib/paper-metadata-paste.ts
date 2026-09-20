/**
 * SciSpace 等からコピーした「タイトル / DOI / 著者 / 年-掲載」のブロックを解析する。
 */

export type ParsedPaperMetadataPaste = {
  title: string;
  publicationYear: string;
  doi: string;
  authors: string;
  venue: string;
  /**
   * true の場合、venue は「年-掲載」のような確度の高い構造から取れたのではなく、
   * 残り1行を掲載誌候補として推測したもの。掲載誌名ではなく分野タグ等の可能性がある。
   */
  venueUncertain: boolean;
  /** true の場合、貼り付け元の "...+N More" 等の省略表記により著者が一部省略されている。 */
  authorsTruncated: boolean;
  /** 省略された著者の推定人数。不明なら null。 */
  truncatedAuthorsCount: number | null;
};

/** ASCII ハイフン・マイナス・en/em dash 等（年-掲載・UI ノイズ除去用） */
const UNICODE_DASH = String.raw`[\u002D\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]`;

/**
 * 中点類（scispace 等のカード表記で「年・DOI・著者」を1行に連結する区切りに使われる）。
 * U+00B7 middle dot / U+2022 bullet / U+2027 hyphenation point / U+2219 bullet operator /
 * U+22C5 dot operator / U+30FB katakana middle dot / U+FF65 halfwidth katakana middle dot
 */
const MIDDLE_DOT = String.raw`[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF65]`;

/** 著者一覧の省略表記（例: "...+3 More" "…+3 more"） */
const TRUNCATED_MORE = /(?:\.{2,3}|\u2026)\s*\+\s*(\d+)\s*More\s*$/iu;

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

type ParsedYearAuthorLine = {
  year: string;
  authors: string;
  truncated: boolean;
  truncatedCount: number | null;
};

/**
 * scispace 等のカードにある「年・(DOI・)著者…」を中点で連結した1行を解析する。
 * 例: "2008⋅C.F. Doran, ... Landweber"
 * 例: "2026⋅DOI⋅Yingfei Yang, Huayu Zhao...+3 More"
 */
function parseYearAuthorLine(s: string): ParsedYearAuthorLine | null {
  const t = stripInvisible(s);
  const m = t.match(new RegExp(`^((?:19|20)\\d{2})\\s*${MIDDLE_DOT}\\s*(.+)$`, "u"));
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1900 || y > 2100) return null;

  let rest = stripUiNoise(m[2].trim());
  // "DOI" というプレースホルダ表記（実際のDOI値ではない）を除去
  rest = rest.replace(new RegExp(`^DOI\\s*${MIDDLE_DOT}\\s*`, "iu"), "").trim();

  let truncated = false;
  let truncatedCount: number | null = null;
  const tm = rest.match(TRUNCATED_MORE);
  if (tm) {
    truncated = true;
    truncatedCount = Number(tm[1]);
    rest = stripUiNoise(rest.slice(0, tm.index).trim().replace(/[\s,;]+$/g, ""));
  }

  if (!rest) return null;
  return { year: m[1], authors: rest, truncated, truncatedCount };
}

function isYearAuthorLine(s: string): boolean {
  return parseYearAuthorLine(s) !== null;
}

function looksLikeAuthorLine(s: string): boolean {
  const t = stripUiNoise(s);
  if (t.length < 12) return false;
  if (/^Title\s*[:：]/iu.test(t)) return false;
  if (isDoiLine(t)) return false;
  if (isYearVenueLine(t)) return false;
  if (isYearAuthorLine(t)) return false;
  return t.includes(",") || /\s+and\s+/i.test(t);
}

/**
 * 解析結果の著者候補が、実は取り違えたタイトル等の誤混入である疑いを検出する。
 * 「候補が1件だけ・かつ長い文章のような形」を、人名リストではないと判定するヒューリスティック。
 * true の場合は自動保存・ピックリスト登録を行わず、ユーザーに確認を求めるべき。
 */
export function looksLikeMisparsedAuthors(names: string[]): boolean {
  if (names.length !== 1) return false;
  const n = names[0]?.trim() ?? "";
  if (n.length <= 60) return false;
  const wordCount = n.split(/\s+/).filter(Boolean).length;
  return /\s+and\s+/i.test(n) || wordCount > 8;
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

/** SciSpace 画面のナビ・ファイル名・TL;DR本文など、メタ行ではないもの */
function isNoiseMetadataLine(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/\.pdf$/i.test(t)) return true;
  if (/^uploaded on\b/i.test(t)) return true;
  if (
    /^(home|agent gallery|templates|files(\s*\(\d+\))?|notebooks(\s*\(\d+\))?|chats(\s*\(\d+\))?|sort|export|share|upload pdfs|pdf upload|column settings|untitled folder|tools|lite|standard quality|en|tl;dr)$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    t.length > 60 &&
    /^(?:this paper|the paper|this study|the study|this work|we (?:present|propose|investigate|show|study)|本研究|本論文)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (t.length > 120 && t.split(/\s+/).length > 18 && /[.!?。]$/.test(t)) {
    return true;
  }
  return false;
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
  let venueUncertain = false;
  let authorsTruncated = false;
  let truncatedAuthorsCount: number | null = null;

  const used = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (isNoiseMetadataLine(lines[i])) used.add(i);
  }

  // 1st pass: 確度の高いメタ行（Title: / DOI / 年-掲載 / 年(・DOI)・著者 / ラベル付き年 / 単独年）を検出
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
      publicationYear = publicationYear || labeledYear[1];
      used.add(i);
      continue;
    }
    const yv = parseYearVenue(line);
    if (yv) {
      publicationYear = publicationYear || yv.year;
      if (!venue) venue = yv.venue;
      used.add(i);
      continue;
    }
    const ya = parseYearAuthorLine(line);
    if (ya) {
      publicationYear = publicationYear || ya.year;
      if (!authors) {
        authors = ya.authors;
        authorsTruncated = ya.truncated;
        truncatedAuthorsCount = ya.truncatedCount;
      }
      used.add(i);
      continue;
    }
    if (/^(?:19|20)\d{2}$/.test(line)) {
      publicationYear = publicationYear || line;
      used.add(i);
      continue;
    }
  }

  // 2nd pass: タイトル未確定なら、未使用行のうち最初の行をタイトルにする
  // （scispace 等のカードは、明示ラベルが無い場合でも先頭行が常にタイトルという前提）
  if (!title) {
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      const line = lines[i];
      if (line.length > 8 && !isNoiseMetadataLine(line)) {
        title = line;
        used.add(i);
        break;
      }
    }
  }

  // 3rd pass: 著者未確定なら、カンマ/"and" を含む行を著者候補として探す
  if (!authors) {
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      const line = lines[i];
      if (looksLikeAuthorLine(line)) {
        authors = stripUiNoise(line);
        used.add(i);
        break;
      }
    }
  }

  // 4th pass: 掲載誌が未確定で、残りの未使用行がちょうど1行なら掲載誌候補として採用する
  // （分野タグ等の可能性があるため venueUncertain フラグを立て、確認が必要なことを示す）
  if (!venue) {
    const restIndexes = lines.map((_, i) => i).filter((i) => !used.has(i));
    if (restIndexes.length === 1) {
      const idx = restIndexes[0];
      const line = lines[idx];
      if (line.length > 0 && line.length <= 120 && !isDoiLine(line)) {
        venue = line;
        venueUncertain = true;
        used.add(idx);
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
      if (!venue) {
        venue = yv.venue;
        venueUncertain = false;
      }
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
      if (!venue) {
        venue = yvTail.venue;
        venueUncertain = false;
      }
    }
  }

  if (!authors && doi) {
    const tail = extractAuthorAfterDoi(raw, doi);
    if (tail && (tail.includes(",") || /\s+and\s+/i.test(tail))) authors = tail;
  }

  return {
    title,
    publicationYear,
    doi,
    authors,
    venue,
    venueUncertain,
    authorsTruncated,
    truncatedAuthorsCount,
  };
}

export function buildDescriptionFromParsedPaste(
  p: ParsedPaperMetadataPaste,
): string {
  const parts: string[] = [];
  if (p.venue) {
    parts.push(p.venueUncertain ? `掲載/分野（未確認）: ${p.venue}` : `掲載: ${p.venue}`);
  }
  if (p.doi) parts.push(`DOI: ${p.doi}`);
  if (p.authors) {
    const suffix =
      p.authorsTruncated
        ? ` ほか${p.truncatedAuthorsCount ?? "数"}名（貼り付け元で省略）`
        : "";
    parts.push(`著者: ${p.authors}${suffix}`);
  }
  return parts.join("\n");
}
