import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { type InboxPdf } from "./inbox.ts";
import { firstLine, log, warn } from "./log.ts";
import { normalizeDoi, normalizeKey, titlesLikelySame, titleUsableForExistingMatch } from "./match.ts";
import { emptyState, loadState } from "./state.ts";
import {
  isBibliographyLabel,
  isHeadingWord,
  isInvalidAuthorValue,
  isNameSuffix,
  isValidAuthorName,
} from "./bibliography.ts";

export type PaperContentKey = {
  doi?: string;
  arxivId?: string;
  title?: string;
  firstAuthor?: string;
};

export type MatchTarget = {
  key: PaperContentKey;
  label: string;
  filename?: string;
  path?: string;
  keptPaper?: string;
};

export type ContentMatchResult = {
  matched: boolean;
  target?: MatchTarget;
  reason?: string;
};

const TARGET_KEY_CACHE = new Map<string, PaperContentKey>();

export function getCachedContentKey(dir: string): PaperContentKey | undefined {
  if (TARGET_KEY_CACHE.has(dir)) return TARGET_KEY_CACHE.get(dir);
  const cacheFile = join(dir, ".content-key.json");
  try {
    if (existsSync(cacheFile)) {
      const parsed = JSON.parse(readFileSync(cacheFile, "utf8")) as PaperContentKey;
      TARGET_KEY_CACHE.set(dir, parsed);
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function saveCachedContentKey(dir: string, key: PaperContentKey): void {
  TARGET_KEY_CACHE.set(dir, key);
  try {
    const cacheFile = join(dir, ".content-key.json");
    writeFileSync(cacheFile, JSON.stringify(key), "utf8");
  } catch {
    /* ignore if paperDir cannot be written */
  }
}

/**
 * arXiv ID を正規化（小文字化、版番号 v1, v2 等は無視）
 * 新形式: 0709.2257, 2301.00123
 * 旧形式: physics/9905030, math.GT/0309136
 * ファイル名または明示プレフィックス付きの単独7桁: 9905030v1.pdf -> 9905030
 */
export function normalizeArxivId(raw: string): string {
  if (!raw) return "";
  const s = raw.trim();
  const m = s.match(
    /(?:arxiv(?:\.org)?(?:\/(?:abs|pdf))?[:\s/]+)?([a-z\-]+(?:\.[a-z\-]+)?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i,
  );
  if (m?.[1]) {
    return m[1].toLowerCase();
  }
  // ファイル名または明示的な arXiv プレフィックス付きの 7 桁のみ許可（無関係な 7 桁数字の誤認を防止）
  const mFilename = s.match(/^(?:arxiv[:\-_])?(\d{7})(?:v\d+)?(?:\.pdf)?$/i);
  if (mFilename?.[1]) {
    return mFilename[1].toLowerCase();
  }
  return "";
}

/**
 * arXiv ID の一致判定（版番号無視）
 * 両方にカテゴリがある場合: カテゴリも含め一致（physics/9905030 と hep-th/9905030 は不一致）
 * 片方が 7 桁のみの場合: 7 桁の ID が一致すれば許容
 */
export function arxivIdsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = a.toLowerCase();
  const nb = b.toLowerCase();
  if (na === nb) return true;

  const aHasCat = na.includes("/");
  const bHasCat = nb.includes("/");
  if (aHasCat && bHasCat) {
    return false;
  }

  const idA = na.split("/").pop();
  const idB = nb.split("/").pop();
  if (idA && idB && idA === idB && /^\d{7}$/.test(idA)) {
    return true;
  }
  return false;
}

/**
 * 著者文字列から筆頭著者の姓（または単一名称）を抽出・正規化
 */
export function normalizeFirstAuthor(raw: string): string {
  if (!raw) return "";
  let s = raw.trim();
  s = s.replace(/^(?:by|authors?|筆頭著者)[:\s]+/i, "").trim();
  s = s.replace(/^\d{4}\s*[·⋅-]\s*/, "").trim();
  const first = s.split(/(?:,|\band\b|&|\n|⋅|·|\+|\/|;|\|)/i)[0]?.trim() ?? "";
  const cleaned = first
    .replace(/\([^)]*\)/g, "")
    .replace(/[*†‡§#0-9]/g, "")
    .replace(/[、,]/g, "")
    .trim();
  if (!cleaned) return "";

  if (cleaned.includes(",")) {
    const parts = cleaned.split(",");
    const surname = parts[0]?.trim();
    if (surname) return normalizeKey(surname);
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    const lastToken = tokens[tokens.length - 1]!;
    return normalizeKey(lastToken);
  }
  return normalizeKey(cleaned);
}

/**
 * 筆頭著者の一致判定
 */
export function firstAuthorsMatch(a: string, b: string): boolean {
  const normA = normalizeFirstAuthor(a);
  const normB = normalizeFirstAuthor(b);
  if (!normA || !normB) return false;
  if (normA.length < 2 || normB.length < 2) return false;
  return normA === normB;
}

const AFFILIATION_LINE_RE =
  /\b(?:department|dept|university|college|faculty|school|institute|laboratory|laboratories|centre|center|hospital|consortium|association|division|corporation|inc\.|ltd\.|corp\.)\b|大学|学部|研究科|研究所|センター|機構|株式会社|専攻|学科|@/i;

function cleanExtractedAuthorToken(token: string): string {
  let s = token.trim();
  s = s.replace(/(?:[\s\-–—·•]+)?Show\s*Less\s*$/iu, "");
  s = s.replace(/(?:(?:\.{2,3}|\u2026)\s*)?\+\s*\d+\s*More\s*$/iu, "");
  s = s.replace(/^[*†‡§#0-9\s]+/, "");
  s = s.replace(/[*†‡§#0-9]+$/g, "");
  s = s.replace(/\([^)]*\)/g, "");
  s = s.replace(/（[^）]*）/g, "");
  s = s.replace(/[\s,;]+$/g, "");
  return s.trim();
}

export function splitFirstPageAuthors(raw: string): string[] {
  const parts = raw
    .split(/[,，、;；／/|\n]|(?<=[*†‡§#0-9])\s+(?=[^\s*†‡§#0-9])/)
    .map((p) => cleanExtractedAuthorToken(p))
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (isNameSuffix(part)) {
      if (out.length > 0) {
        out[out.length - 1] = `${out[out.length - 1]}, ${part}`;
      }
      continue;
    }
    out.push(part);
  }
  return out;
}

const TITLE_WORD_RE =
  /\b(?:for|with|using|through|based|approach|approaches|learning|processing|neural|deep|survey|system|systems|review|networks?|methods?|methodology|analysis|study|studies|models?|towards|via|an|the|of|in|on|to|from|applications?|framework|frameworks|architecture|algorithms?|theory|empirical|evaluation|design|efficient|automated|comparative|introduction|performance|optimization|detection|generation|classification)\b/i;

const JP_TITLE_PHRASE_RE =
  /(?:における|に関する|について|を用いた|による|のための|の検討|の提案|とその|および|または|比較|調査|開発|設計|評価|考察|研究|報告|概要)/;

export function looksLikePersonName(name: string): boolean {
  const s = name.replace(/[*†‡§#0-9]/g, "").trim();
  if (!s || s.length < 2 || s.length > 60) return false;
  if (TITLE_WORD_RE.test(s) || JP_TITLE_PHRASE_RE.test(s)) return false;

  // Japanese / CJK full name: 2 to 8 characters (Kanji/Hiragana/Katakana)
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\s]{2,10}$/u.test(s)) {
    const clean = s.replace(/\s+/g, "");
    return clean.length >= 2 && clean.length <= 8;
  }

  // Latin name: e.g. "Hugh Everett, III", "John Doe", "A. B. Smith"
  const withoutSuffix = s.replace(/,\s*(?:Jr\.?|Sr\.?|I{2,4}|IV|VI{1,3}|[123](?:st|nd|rd))$/i, "").trim();
  const tokens = withoutSuffix.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) {
    // Known uppercase organization like "OPENAI"
    if (tokens.length === 1 && /^[A-Z0-9]{3,12}$/.test(tokens[0]!)) {
      return true;
    }
    return false;
  }

  // Each token must start with an uppercase letter, or be an accepted name particle (van, de, etc.)
  const NAME_TOKEN_RE =
    /^(?:[\p{Lu}][\p{L}\-']+|[\p{Lu}]\.?|(?:van|von|de|del|da|di|der|den|la|le))$/u;
  return tokens.every((t) => NAME_TOKEN_RE.test(t));
}

function looksLikeFirstPageAuthorLine(line: string, title?: string): boolean {
  const t = line.trim();
  if (t.length < 2 || t.length > 120) return false;
  if (AFFILIATION_LINE_RE.test(t)) return false;
  if (isInvalidAuthorValue(t, title)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^[0-9\s.,;:\-_/()]+$/.test(t)) return false;
  const authors = splitFirstPageAuthors(t);
  if (authors.length === 0) return false;
  return authors.every((a) => looksLikePersonName(a) && isValidAuthorName(a, title));
}

/**
 * 1ページ目テキストから題名と筆頭著者候補を抽出
 */
export function parseFirstPageTitleAndAuthor(text: string): {
  title?: string;
  author?: string;
  authors?: string[];
} {
  if (!text.trim()) return {};
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const nonHeaderLines: string[] = [];
  for (const line of lines) {
    if (/^arxiv(?:\.org)?[:\s/]/i.test(line)) continue;
    if (/^\[(?:physics|math|cs|gr-qc|hep|cond-mat|astro-ph|quant-ph)[^\]]*\]/i.test(line)) continue;
    if (/^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{4}/i.test(line)) continue;
    if (/^https?:\/\//i.test(line)) continue;
    if (/^downloaded from/i.test(line)) continue;
    nonHeaderLines.push(line);
  }

  // Explicit by or 著者 / 執筆者 / Authors
  const explicitIdx = nonHeaderLines.findIndex((l) =>
    /^(?:by\s+[A-Z\p{L}]|(?:authors?|著者(?:名)?|執筆者)[:：\s])/iu.test(l),
  );
  if (explicitIdx > 0) {
    const titleLines = nonHeaderLines.slice(0, explicitIdx);
    const title = titleLines.join(" ").replace(/\s+/g, " ").trim();
    const rawAuthor = nonHeaderLines[explicitIdx]!
      .replace(/^(?:by|(?:authors?|著者(?:名)?|執筆者)[:：])\s*/i, "")
      .trim();
    const authors = splitFirstPageAuthors(rawAuthor);
    const author = authors.find((a) => isValidAuthorName(a, title));
    return {
      title: title || undefined,
      author: author || undefined,
      authors: authors.length > 0 ? authors : undefined,
    };
  }

  const abstractIdx = nonHeaderLines.findIndex((l) =>
    /^(?:abstract|tl;dr|tldr|要旨|概要|抄録|はじめに|序論|緒言|1\.\s*(?:はじめに|序論|緒言|introduction))\b/i.test(l) ||
    isHeadingWord(l),
  );
  const candidateLines =
    abstractIdx > 0 ? nonHeaderLines.slice(0, abstractIdx) : nonHeaderLines.slice(0, 8);

  if (candidateLines.length === 0) return {};

  let authorLineIdx = -1;
  for (let i = 1; i < candidateLines.length; i++) {
    const line = candidateLines[i]!;
    if (AFFILIATION_LINE_RE.test(line)) continue;
    if (looksLikeFirstPageAuthorLine(line, candidateLines[0])) {
      authorLineIdx = i;
      break;
    }
  }

  if (authorLineIdx > 0) {
    const title = candidateLines.slice(0, authorLineIdx).join(" ").replace(/\s+/g, " ").trim();
    const line = candidateLines[authorLineIdx]!;
    const authors = splitFirstPageAuthors(line);
    const author = authors.find((a) => isValidAuthorName(a, title) && looksLikePersonName(a));
    return {
      title: title || undefined,
      author: author || undefined,
      authors: authors.length > 0 ? authors : undefined,
    };
  }

  const fullTitle = candidateLines.join(" ").replace(/\s+/g, " ").trim();
  return { title: fullTitle || undefined };
}

/**
 * PDF の中身（テキスト・メタデータ）から照合キー（DOI, arXiv ID, 題名, 筆頭著者）を抽出
 */
export async function extractPaperContentKeyFromPdf(
  pdfPathOrBuffer: string | Buffer,
): Promise<PaperContentKey> {
  try {
    let buf: Buffer;
    let filename = "";
    if (typeof pdfPathOrBuffer === "string") {
      if (!pdfPathOrBuffer || !existsSync(pdfPathOrBuffer)) {
        return {};
      }
      filename = basename(pdfPathOrBuffer);
      buf = readFileSync(pdfPathOrBuffer);
    } else {
      buf = pdfPathOrBuffer;
    }
    if (!buf || buf.length === 0) return {};

    const uint8 = new Uint8Array(buf.length);
    uint8.set(buf);

    const mod = await import("pdf-parse");
    const pdfParse = (mod.default ?? mod) as (
      dataBuffer: Buffer | Uint8Array,
      options?: { max?: number },
    ) => Promise<{
      text: string;
      numpages: number;
      info?: Record<string, any>;
      metadata?: Record<string, any>;
    }>;

    const data = await pdfParse(uint8, { max: 2 });
    const text = data?.text ?? "";
    const info = data?.info ?? {};
    const metadata = data?.metadata ?? {};

    const key: PaperContentKey = {};

    // 1. DOI
    const doiMetaCandidate =
      info.doi ||
      info.Subject ||
      info.Keywords ||
      (metadata._metadata && (metadata._metadata["prism:doi"] || metadata._metadata["dc:identifier"]));
    if (doiMetaCandidate) {
      const d = normalizeDoi(String(doiMetaCandidate));
      if (d) key.doi = d.toLowerCase();
    }
    if (!key.doi && text) {
      const d = normalizeDoi(text.slice(0, 4000));
      if (d) key.doi = d.toLowerCase();
    }

    // 2. arXiv ID
    const arxivCandidates = [
      String(info.Title ?? ""),
      String(info.Subject ?? ""),
      text.slice(0, 3000),
      filename,
    ];
    for (const cand of arxivCandidates) {
      const aid = normalizeArxivId(cand);
      if (aid) {
        key.arxivId = aid;
        break;
      }
    }

    // 3. Title & First Author
    const infoTitle = typeof info.Title === "string" ? info.Title.trim() : "";
    const infoAuthor = typeof info.Author === "string" ? info.Author.trim() : "";

    const parsedFirstPage = parseFirstPageTitleAndAuthor(text);
    if (parsedFirstPage.title) {
      key.title = parsedFirstPage.title;
    } else if (infoTitle && !infoTitle.toLowerCase().startsWith("arxiv:") && titleUsableForExistingMatch(infoTitle, filename)) {
      key.title = infoTitle;
    }

    if (parsedFirstPage.author) {
      key.firstAuthor = parsedFirstPage.author;
    } else if (infoAuthor && !/^(?:unknown|user|admin)$/i.test(infoAuthor)) {
      key.firstAuthor = infoAuthor;
    }

    return key;
  } catch (err) {
    warn(`PDF 中身解析エラー: ${firstLine(err)}`);
    return {};
  }
}

/**
 * state.json から照合キーを抽出
 */
export function extractPaperContentKeyFromState(state: {
  title?: string;
  doi?: string;
  venue?: string;
  filesPaste?: string;
  tldr?: string;
  scispaceUrl?: string;
  filename?: string;
}): PaperContentKey {
  const key: PaperContentKey = {};

  // 1. DOI
  if (state.doi) {
    const d = normalizeDoi(state.doi);
    if (d) key.doi = d.toLowerCase();
  }
  if (!key.doi && state.filesPaste) {
    const d = normalizeDoi(state.filesPaste);
    if (d) key.doi = d.toLowerCase();
  }

  // 2. arXiv ID
  const arxivCandidates = [
    state.venue ?? "",
    state.filesPaste ?? "",
    state.tldr ?? "",
    state.filename ?? "",
    state.scispaceUrl ?? "",
  ];
  for (const cand of arxivCandidates) {
    const aid = normalizeArxivId(cand);
    if (aid) {
      key.arxivId = aid;
      break;
    }
  }

  // 3. Title & First Author
  if (state.filesPaste) {
    const lines = state.filesPaste.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2 && lines[1] && titleUsableForExistingMatch(lines[1], state.filename ?? "")) {
      key.title = lines[1];
    }
    if (lines.length >= 3 && lines[2]) {
      const auth = normalizeFirstAuthor(lines[2]);
      if (auth) key.firstAuthor = lines[2];
    }
  }
  if (!key.title && state.title && titleUsableForExistingMatch(state.title, state.filename ?? "")) {
    key.title = state.title;
  }
  if (!key.firstAuthor && state.venue) {
    const auth = normalizeFirstAuthor(state.venue);
    if (auth) key.firstAuthor = state.venue;
  }

  return key;
}

/**
 * 2つの論文キーの一致判定（強いキー順）:
 * 1. DOI
 * 2. arXiv ID（版番号無視）
 * 3. 1ページ目題名 ＋ 筆頭著者の一致（題名だけでは一致にしない）
 */
export function matchPaperContent(
  candidate: PaperContentKey,
  target: PaperContentKey,
): { matched: boolean; reason?: string } {
  // 1. DOI
  if (candidate.doi && target.doi) {
    if (candidate.doi === target.doi) {
      return { matched: true, reason: `DOI 一致 (${candidate.doi})` };
    }
    return { matched: false };
  }

  // 2. arXiv ID
  if (candidate.arxivId && target.arxivId) {
    if (arxivIdsMatch(candidate.arxivId, target.arxivId)) {
      return { matched: true, reason: `arXiv ID 一致 (${candidate.arxivId})` };
    }
    return { matched: false };
  }

  // 3. 題名 ＋ 筆頭著者
  if (candidate.title && target.title && candidate.firstAuthor && target.firstAuthor) {
    if (titlesLikelySame(candidate.title, target.title)) {
      if (firstAuthorsMatch(candidate.firstAuthor, target.firstAuthor)) {
        return {
          matched: true,
          reason: `題名・筆頭著者一致 (${candidate.title} / ${candidate.firstAuthor})`,
        };
      }
    }
  }

  return { matched: false };
}

/**
 * 照合先一覧から一致する論文を探す
 * candidateStem が渡された場合、自身を正本とする duplicates 配下（target.keptPaper === candidateStem）は照合から除外する
 */
export function findContentDuplicateMatch(
  candidateKey: PaperContentKey,
  targets: readonly MatchTarget[],
  candidateStem?: string,
): ContentMatchResult {
  if (!candidateKey.doi && !candidateKey.arxivId && (!candidateKey.title || !candidateKey.firstAuthor)) {
    return { matched: false };
  }

  for (const target of targets) {
    if (candidateStem && target.keptPaper && target.keptPaper === candidateStem) {
      continue;
    }
    const res = matchPaperContent(candidateKey, target.key);
    if (res.matched) {
      return {
        matched: true,
        target,
        reason: res.reason,
      };
    }
  }

  return { matched: false };
}

/**
 * 一致した PDF を hold/ フォルダへ移動（同名があっても上書き・削除せず連番を付ける）
 */
export function movePdfToHold(inboxPdfPath: string, holdDir: string): string {
  mkdirSync(holdDir, { recursive: true });
  const originalName = basename(inboxPdfPath);
  const ext = extname(originalName);
  const stem = ext ? originalName.slice(0, -ext.length) : originalName;
  let dest = join(holdDir, originalName);
  let counter = 2;
  while (existsSync(dest)) {
    dest = join(holdDir, `${stem} (${counter})${ext}`);
    counter++;
  }
  try {
    renameSync(inboxPdfPath, dest);
    return dest;
  } catch {
    copyFileSync(inboxPdfPath, dest);
    unlinkSync(inboxPdfPath);
    return dest;
  }
}

/**
 * work/ と duplicates/ から既存の照合先一覧を構築
 * state.json にキーが不足している場合は作業フォルダ内の PDF から補完しキャッシュする
 */
export async function loadExistingMatchTargets(
  workDir: string,
  duplicatesDir: string,
  exceptPaperDir?: string,
): Promise<MatchTarget[]> {
  const targets: MatchTarget[] = [];
  const seenLabels = new Set<string>();

  // 1. work/
  let workNames: string[] = [];
  try {
    workNames = readdirSync(workDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    workNames = [];
  }

  for (const name of workNames) {
    const paperDir = join(workDir, name);
    if (exceptPaperDir && paperDir === exceptPaperDir) continue;
    const fallback = emptyState({
      filename: `${name}.pdf`,
      inboxPdfPath: join(paperDir, `${name}.pdf`),
      paperDir,
    });
    const state = loadState(paperDir, fallback);
    let key = extractPaperContentKeyFromState(state);
    if (!key.doi && !key.arxivId && (!key.title || !key.firstAuthor)) {
      const cached = getCachedContentKey(paperDir);
      if (cached) {
        key = cached;
      } else {
        try {
          const files = readdirSync(paperDir);
          const pdfFile = files.find((f) => f.toLowerCase().endsWith(".pdf") && !f.startsWith("."));
          if (pdfFile) {
            const pdfKey = await extractPaperContentKeyFromPdf(join(paperDir, pdfFile));
            if (pdfKey.doi) key.doi = pdfKey.doi;
            if (pdfKey.arxivId) key.arxivId = pdfKey.arxivId;
            if (pdfKey.title && !key.title) key.title = pdfKey.title;
            if (pdfKey.firstAuthor && !key.firstAuthor) key.firstAuthor = pdfKey.firstAuthor;
            saveCachedContentKey(paperDir, key);
          }
        } catch {
          /* ignore */
        }
      }
    }
    const label = `work/${name}`;
    if (!seenLabels.has(label)) {
      seenLabels.add(label);
      targets.push({
        key,
        label,
        filename: state.filename || `${name}.pdf`,
        path: paperDir,
      });
    }
  }

  // 2. duplicates/
  try {
    const keptDirs = readdirSync(duplicatesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
    for (const kept of keptDirs) {
      const keptPath = join(duplicatesDir, kept);
      let dupDirs: string[] = [];
      try {
        dupDirs = readdirSync(keptPath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => d.name);
      } catch {
        continue;
      }
      for (const dup of dupDirs) {
        const dupPath = join(keptPath, dup);
        if (exceptPaperDir && dupPath === exceptPaperDir) continue;
        const fallback = emptyState({
          filename: `${dup}.pdf`,
          inboxPdfPath: join(dupPath, `${dup}.pdf`),
          paperDir: dupPath,
        });
        const state = loadState(dupPath, fallback);
        let key = extractPaperContentKeyFromState(state);
        if (!key.doi && !key.arxivId && (!key.title || !key.firstAuthor)) {
          const cached = getCachedContentKey(dupPath);
          if (cached) {
            key = cached;
          } else {
            try {
              const files = readdirSync(dupPath);
              const pdfFile = files.find((f) => f.toLowerCase().endsWith(".pdf") && !f.startsWith("."));
              if (pdfFile) {
                const pdfKey = await extractPaperContentKeyFromPdf(join(dupPath, pdfFile));
                if (pdfKey.doi) key.doi = pdfKey.doi;
                if (pdfKey.arxivId) key.arxivId = pdfKey.arxivId;
                if (pdfKey.title && !key.title) key.title = pdfKey.title;
                if (pdfKey.firstAuthor && !key.firstAuthor) key.firstAuthor = pdfKey.firstAuthor;
                saveCachedContentKey(dupPath, key);
              }
            } catch {
              /* ignore */
            }
          }
        }
        const label = `duplicates/${kept}/${dup}`;
        if (!seenLabels.has(label)) {
          seenLabels.add(label);
          targets.push({
            key,
            label,
            filename: state.filename || `${dup}.pdf`,
            path: dupPath,
            keptPaper: kept,
          });
        }
      }
    }
  } catch {
    /* ignore if duplicates dir is absent */
  }

  return targets;
}

/**
 * inbox の PDF リストから同一論文を検出し、hold/ へ移動して除外
 * 既に作業中の論文（completed がある、または eduShareTestId がある）や
 * 自分自身の作業フォルダ・自分の duplicates は照合から外す
 */
export async function filterDuplicateInboxPdfs(
  items: readonly InboxPdf[],
  targets: MatchTarget[],
  holdDir: string,
  deps = {
    extractKey: extractPaperContentKeyFromPdf,
  },
): Promise<InboxPdf[]> {
  const kept: InboxPdf[] = [];
  for (const item of items) {
    if (!existsSync(item.absPath)) continue;

    // 既に作業開始済みの論文は除外対象にしない
    const state = loadState(
      item.paperDir,
      emptyState({
        filename: item.filename,
        inboxPdfPath: item.absPath,
        paperDir: item.paperDir,
      }),
    );
    if (state.completed.length > 0 || state.eduShareTestId) {
      kept.push(item);
      continue;
    }

    // 自分自身の absPath、work フォルダ、および自分を正本とする duplicates は除外して照合
    const relevantTargets = targets.filter(
      (t) =>
        t.path !== item.absPath &&
        t.path !== item.paperDir &&
        t.filename !== item.filename &&
        (!t.keptPaper || t.keptPaper !== item.stem),
    );

    let key: PaperContentKey;
    try {
      key = await deps.extractKey(item.absPath);
    } catch {
      key = {};
    }
    const match = findContentDuplicateMatch(key, relevantTargets, item.stem);
    if (match.matched && match.target) {
      const dest = movePdfToHold(item.absPath, holdDir);
      log(
        `同一論文が既に存在するため inbox から hold/ へ移動します: ${item.filename} → ${dest} (一致先: ${match.target.label}, 理由: ${match.reason})`,
      );
      continue;
    }
    // 同一実行中の後続 inbox PDF の照合先に追加（重複登録防止）
    if (!targets.some((t) => t.path === item.absPath)) {
      targets.push({
        key,
        label: `inbox/${item.filename}`,
        filename: item.filename,
        path: item.absPath,
      });
    }
    kept.push(item);
  }
  return kept;
}
