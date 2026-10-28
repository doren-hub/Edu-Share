import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { type InboxPdf } from "./inbox.ts";
import { firstLine, log, warn } from "./log.ts";
import { normalizeDoi, normalizeKey, titlesLikelySame, titleUsableForExistingMatch } from "./match.ts";
import { emptyState, loadState } from "./state.ts";

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
};

export type ContentMatchResult = {
  matched: boolean;
  target?: MatchTarget;
  reason?: string;
};

/**
 * arXiv ID を正規化（小文字化、版番号 v1, v2 等は無視）
 * 新形式: 0709.2257, 2301.00123
 * 旧形式: physics/9905030, math.GT/0309136
 * 単独7桁: 9905030
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
  const m7 = s.match(/\b(\d{7})(?:v\d+)?(?:\.pdf)?\b/i);
  if (m7?.[1]) {
    return m7[1].toLowerCase();
  }
  return "";
}

/**
 * arXiv ID の一致判定（版番号無視）
 * physics/9905030 と 9905030 の突き合わせも許容
 */
export function arxivIdsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = a.toLowerCase();
  const nb = b.toLowerCase();
  if (na === nb) return true;
  if (na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`)) return true;
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

/**
 * 1ページ目テキストから題名と筆頭著者候補を抽出
 */
export function parseFirstPageTitleAndAuthor(text: string): { title?: string; author?: string } {
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
    nonHeaderLines.push(line);
  }

  const byIdx = nonHeaderLines.findIndex((l) => /^by\s+[A-Z\p{L}]/iu.test(l));
  if (byIdx > 0) {
    const titleLines = nonHeaderLines.slice(0, byIdx);
    const title = titleLines.join(" ").replace(/\s+/g, " ").trim();
    const authorLine = nonHeaderLines[byIdx]!.replace(/^by\s+/i, "").trim();
    return {
      title: title || undefined,
      author: authorLine || undefined,
    };
  }

  const abstractIdx = nonHeaderLines.findIndex((l) => /^abstract\b/i.test(l));
  const candidateLines = abstractIdx > 0 ? nonHeaderLines.slice(0, abstractIdx) : nonHeaderLines.slice(0, 6);

  if (candidateLines.length >= 2) {
    const title = candidateLines[0]!;
    const author = candidateLines[1]!;
    return {
      title,
      author,
    };
  } else if (candidateLines.length === 1) {
    return {
      title: candidateLines[0],
    };
  }

  return {};
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
    } else if (infoAuthor && !/^unknown|user|admin$/i.test(infoAuthor)) {
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
 */
export function findContentDuplicateMatch(
  candidateKey: PaperContentKey,
  targets: readonly MatchTarget[],
): ContentMatchResult {
  if (!candidateKey.doi && !candidateKey.arxivId && (!candidateKey.title || !candidateKey.firstAuthor)) {
    return { matched: false };
  }

  for (const target of targets) {
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
 * 一致した PDF を hold/ フォルダへ移動
 */
export function movePdfToHold(inboxPdfPath: string, holdDir: string): string {
  mkdirSync(holdDir, { recursive: true });
  const dest = join(holdDir, basename(inboxPdfPath));
  if (existsSync(dest)) {
    if (inboxPdfPath !== dest && existsSync(inboxPdfPath)) {
      try {
        unlinkSync(inboxPdfPath);
      } catch {
        /* 入力側が残っても続行 */
      }
    }
    return dest;
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
    const key = extractPaperContentKeyFromState(state);
    if (!key.doi && !key.arxivId && (!key.title || !key.firstAuthor)) {
      try {
        const files = readdirSync(paperDir);
        const pdfFile = files.find((f) => f.toLowerCase().endsWith(".pdf") && !f.startsWith("."));
        if (pdfFile) {
          const pdfKey = await extractPaperContentKeyFromPdf(join(paperDir, pdfFile));
          if (pdfKey.doi) key.doi = pdfKey.doi;
          if (pdfKey.arxivId) key.arxivId = pdfKey.arxivId;
          if (pdfKey.title && !key.title) key.title = pdfKey.title;
          if (pdfKey.firstAuthor && !key.firstAuthor) key.firstAuthor = pdfKey.firstAuthor;
        }
      } catch {
        /* ignore */
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
        const key = extractPaperContentKeyFromState(state);
        if (!key.doi && !key.arxivId && (!key.title || !key.firstAuthor)) {
          try {
            const files = readdirSync(dupPath);
            const pdfFile = files.find((f) => f.toLowerCase().endsWith(".pdf") && !f.startsWith("."));
            if (pdfFile) {
              const pdfKey = await extractPaperContentKeyFromPdf(join(dupPath, pdfFile));
              if (pdfKey.doi) key.doi = pdfKey.doi;
              if (pdfKey.arxivId) key.arxivId = pdfKey.arxivId;
              if (pdfKey.title && !key.title) key.title = pdfKey.title;
              if (pdfKey.firstAuthor && !key.firstAuthor) key.firstAuthor = pdfKey.firstAuthor;
            }
          } catch {
            /* ignore */
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
    let key: PaperContentKey;
    try {
      key = await deps.extractKey(item.absPath);
    } catch {
      key = {};
    }
    const match = findContentDuplicateMatch(key, targets);
    if (match.matched && match.target) {
      const dest = movePdfToHold(item.absPath, holdDir);
      log(
        `同一論文が既に存在するため inbox から hold/ へ移動します: ${item.filename} → ${dest} (一致先: ${match.target.label}, 理由: ${match.reason})`,
      );
      continue;
    }
    // 同一実行中の後続 inbox PDF の照合先に追加
    targets.push({
      key,
      label: `inbox/${item.filename}`,
      filename: item.filename,
      path: item.absPath,
    });
    kept.push(item);
  }
  return kept;
}
