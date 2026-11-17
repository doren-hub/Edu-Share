import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidAuthorName, titleKey } from "./bibliography.ts";
import { parseFirstPageTitleAndAuthor } from "./content-match.ts";
import { fetchCrossrefWork, type CrossrefWork } from "./crossref.ts";
import { FALLBACK_AUTHOR_NAME, rawAuthorFromFilesPaste } from "./edushare-form.ts";
import { titlesLikelySame } from "./match.ts";
import { PDF_TITLE_CHECK_PREFIX_CHARS } from "./pdf-grounding.ts";
import { extractPdfText } from "./pdf-text.ts";
import { doiFromHrefOrText } from "./scispace-card.ts";
import { type PaperState } from "./state.ts";

export type AuthorStatus = "unset" | "invalid" | "ok";

export type AuthorAuditItem = {
  paper: string;
  filename: string;
  currentAuthor: string;
  status: AuthorStatus;
  reason?: string;
  candidateAuthor: string | null;
  candidateSource: "pdf" | "doi" | null;
};

export type AuthorAuditResult = {
  total: number;
  unsetCount: number;
  invalidCount: number;
  okCount: number;
  recoverableCount: number;
  items: AuthorAuditItem[];
};

export type AuditAuthorsDeps = {
  extractPdfText?: (path: string) => Promise<string | undefined>;
  fetchCrossrefWork?: (doi: string) => Promise<CrossrefWork | null>;
};

export async function auditAuthors(opts: {
  workDir: string;
  deps?: AuditAuthorsDeps;
}): Promise<AuthorAuditResult> {
  const { workDir } = opts;
  const deps = {
    extractPdfText: opts.deps?.extractPdfText ?? extractPdfText,
    fetchCrossrefWork: opts.deps?.fetchCrossrefWork ?? fetchCrossrefWork,
  };

  const result: AuthorAuditResult = {
    total: 0,
    unsetCount: 0,
    invalidCount: 0,
    okCount: 0,
    recoverableCount: 0,
    items: [],
  };

  if (!existsSync(workDir)) {
    return result;
  }

  const entries = readdirSync(workDir, { withFileTypes: true });
  const paperDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  for (const paperName of paperDirs) {
    const dirPath = join(workDir, paperName);
    const stateFile = join(dirPath, "state.json");
    if (!existsSync(stateFile)) continue;

    let state: PaperState;
    try {
      state = JSON.parse(readFileSync(stateFile, "utf8")) as PaperState;
    } catch {
      continue;
    }

    result.total += 1;

    // Determine current author
    // 既存の state.json には author 欄がないため、state.author が未設定なら
    // 従来のパイプラインが採用した rawAuthorFromFilesPaste で復元し、
    // それが isValidAuthorName を満たさない場合は「おかしい値」として検出する
    let current = (state.author ?? "").trim();
    if (!current) {
      current = rawAuthorFromFilesPaste(state.filesPaste ?? "");
    }
    if (!current) {
      current = FALLBACK_AUTHOR_NAME;
    }

    // Determine status
    let status: AuthorStatus = "ok";
    let reason: string | undefined;

    if (
      !current ||
      current === FALLBACK_AUTHOR_NAME ||
      current === "未設定" ||
      current === "その他" ||
      current.startsWith("その他（")
    ) {
      status = "unset";
      reason = "未設定";
      result.unsetCount += 1;
    } else if (!isValidAuthorName(current, state.title)) {
      status = "invalid";
      reason = `おかしい値: ${current}`;
      result.invalidCount += 1;
    } else {
      result.okCount += 1;
      continue; // Skip valid authors from audit output list
    }

    // Seek replacement candidate (PDF 1st page -> DOI)
    let candidateAuthor: string | null = null;
    let candidateSource: "pdf" | "doi" | null = null;

    let pdfText: string | undefined;
    let pdfPath = "";
    if (state.filename && existsSync(join(dirPath, state.filename))) {
      pdfPath = join(dirPath, state.filename);
    } else if (state.inboxPdfPath && existsSync(state.inboxPdfPath)) {
      pdfPath = state.inboxPdfPath;
    } else {
      const files = readdirSync(dirPath);
      const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf") && !f.startsWith("."));
      if (pdf) pdfPath = join(dirPath, pdf);
    }

    if (pdfPath) {
      try {
        pdfText = await deps.extractPdfText(pdfPath);
      } catch {
        /* ignore */
      }
    }

    if (pdfText) {
      const parsed = parseFirstPageTitleAndAuthor(pdfText);
      if (parsed.author && isValidAuthorName(parsed.author, state.title)) {
        candidateAuthor = parsed.author.slice(0, 80);
        candidateSource = "pdf";
      }
    }

    if (!candidateAuthor) {
      const prefix = pdfText ? pdfText.slice(0, PDF_TITLE_CHECK_PREFIX_CHARS) : "";
      const doi = state.doi || (prefix ? doiFromHrefOrText(prefix) : "");
      if (doi) {
        try {
          const work = await deps.fetchCrossrefWork(doi);
          if (work && work.authors.length > 0) {
            const workKey = titleKey(work.title);
            const titleMatches = state.title
              ? titlesLikelySame(work.title, state.title)
              : Boolean(prefix && workKey && titleKey(prefix).includes(workKey));
            if (titleMatches) {
              const first = work.authors[0]?.trim();
              if (first && isValidAuthorName(first, state.title)) {
                candidateAuthor = first.slice(0, 80);
                candidateSource = "doi";
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (candidateAuthor) {
      result.recoverableCount += 1;
    }

    result.items.push({
      paper: paperName,
      filename: state.filename || `${paperName}.pdf`,
      currentAuthor: current,
      status,
      reason,
      candidateAuthor,
      candidateSource,
    });
  }

  return result;
}
