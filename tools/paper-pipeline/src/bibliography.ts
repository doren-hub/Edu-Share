import type { CrossrefWork } from "./crossref.ts";
import { isScannedPdfText, PDF_TITLE_CHECK_PREFIX_CHARS } from "./pdf-grounding.ts";

const NAME_SUFFIX_RE =
  /^(?:[Jj][Rr]\.?|[Ss][Rr]\.?|I{2,4}|IV|VI{1,3}|[123](?:st|nd|rd))$/i;

export function isNameSuffix(value: string): boolean {
  return NAME_SUFFIX_RE.test(value.trim());
}

const HEADING_WORDS = new Set([
  "graph", "graphs", "figure", "figures", "table", "tables", "chart", "charts",
  "index", "indexes", "indices", "contents", "introduction", "introductions",
  "abstract", "abstracts", "conclusion", "conclusions", "reference", "references",
  "bibliography", "appendix", "appendixes", "appendices", "overview", "summary",
  "background", "results", "discussion", "method", "methods", "methodology",
  "keywords", "acknowledgement", "acknowledgements", "acknowledgment", "acknowledgments",
  "要旨", "要約", "概要", "目次", "はじめに", "序論", "本論", "結論", "考察",
  "参考文献", "付録", "謝辞", "図", "表",
]);

export function isHeadingWord(value: string): boolean {
  const t = value.trim().toLowerCase().replace(/[:：\s]+$/, "");
  return HEADING_WORDS.has(t);
}

/** Standalone UI labels are never bibliographic values. */
export function isBibliographyLabel(value: string): boolean {
  const text = value.replace(/[:：\s]+$/g, "").trim();
  return /^(doi|journal|authors?|title|venue|publication|published in|publication year|year|著者|掲載先|掲載誌|タイトル|論文タイトル|発表年|年|不明|unknown|n\/a|none|未設定|著者未設定|なし|無|-)$/i.test(text);
}

export function isInvalidAuthorValue(value: string, title?: string): boolean {
  const text = value.trim();
  if (text.length < 2 || text.length > 100) return true;
  if (/^DOI\s*[:：]?\s*(?:10\.|$)/i.test(text)) return true;
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(text) || /^10\.\d{4,}\//.test(text)) return true;
  if (isBibliographyLabel(text)) return true;
  if (isNameSuffix(text)) return true;
  if (isHeadingWord(text)) return true;
  if (/^(?:(?:\.{2,3}|\u2026)\s*)?\+\s*\d+\s*More$/i.test(text)) return true;
  if (/^(?:[\s\-–—·•]+)?Show\s*Less$/i.test(text)) return true;
  if (/^[\d\s.,;:\-_/()]+$/.test(text)) return true;
  if (title) {
    const tKey = titleKey(title);
    const aKey = titleKey(text);
    if (aKey && tKey && (aKey === tKey || (aKey.length >= 8 && tKey.startsWith(aKey)))) {
      return true;
    }
  }
  return false;
}

export function isValidAuthorName(value: string, title?: string): boolean {
  return !isInvalidAuthorValue(value, title);
}

export function authorsLookInvalid(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (/^DOI\s*[:：]?\s*(?:10\.|$)/i.test(text)) return true;
  if (/^(?:(?:\.{2,3}|\u2026)\s*)?\+\s*\d+\s*More$/i.test(text)) return true;
  if (/^(?:[\s\-–—·•]+)?Show\s*Less$/i.test(text)) return true;
  if (isNameSuffix(text)) return true;
  if (isHeadingWord(text)) return true;
  if (isBibliographyLabel(text)) return true;
  const parts = text.split(/[,;·⋅•\n]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1 && (isNameSuffix(parts[0]!) || isHeadingWord(parts[0]!) || isBibliographyLabel(parts[0]!))) {
    return true;
  }
  return parts.some((part) => isBibliographyLabel(part) && !isNameSuffix(part));
}

export function titleKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function titleLooksTruncated(value: string): boolean {
  return /(?:\.{3}|…|\.\s*\.\s*\.)\s*$/.test(value.trim());
}

export function isShorterTitle(candidate: string, complete: string): boolean {
  const short = titleKey(candidate);
  const full = titleKey(complete);
  return short.length >= 12 && full.startsWith(`${short} `);
}

/** Reject a visible prefix when the original header visibly continues; never guess its missing words. */
export function titleHasPdfContinuation(candidate: string, pdfText: string): boolean {
  const key = titleKey(candidate);
  if (key.length < 12) return false;
  const lines = pdfText.slice(0, PDF_TITLE_CHECK_PREFIX_CHARS).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const continuation = (text: string, following: string[]) => {
    // Do not search through a non-narrative line (e.g. authors) for prose.
    // No names are inferred. Only an immediate narrative line or "On the basis"
    // wrapped before "of ..." can extend the abstract evidence window.
    const narrativeStart = /^(?:we|i|this\s+(?:study|paper))\s+/i;
    const contextLines = [text];
    for (const line of following) {
      if (!narrativeStart.test(line) &&
          !(/^on\s+the\s+basis$/i.test(contextLines.join(" ")) && /^of\b/i.test(line))) break;
      contextLines.push(line);
    }
    const context = contextLines.join(" ").split(/\b(?:abstract|keywords|introduction)\b/i)[0]!;
    if (/^on\s+the\s+basis\b/i.test(text) &&
        /\b(?:we|i|this\s+(?:study|paper))\s+(?:(?:present|propose|compare|evaluate|examine|investigate|show|aim|analy[sz]e)s?|discuss(?:es)?|has|have)\b/i.test(context)) return false;
    return !/^in\s+this\b/i.test(text) &&
      /^(?:(?:for|of|with|based|using|and|in|on)\b|(?:a\s+)?(?:tool|framework|approach|method|model|system)\s+(?:for|of|with|to)\b)/i.test(text) &&
      !/abstract|keywords|doi|@|\d|\b(?:department|university|institute|school|faculty|laboratory|centre|center|hospital|consortium|association)\b/i.test(text);
  };
  return lines.some((line, index) => {
    const text = titleKey(line);
    if (text.startsWith(`${key} `)) return continuation(text.slice(key.length + 1), lines.slice(index + 1, index + 3));
    return text === key && continuation(lines[index + 1] ?? "", lines.slice(index + 2, index + 4));
  });
}

export function venueMatchesAuthors(venue: string, authors: string): boolean {
  const key = titleKey(venue);
  return Boolean(key && authors.split(/[,;\n]/).some(author => titleKey(author) === key)) ||
    Boolean(key && key === titleKey(authors));
}

/** A DOI must be read from this PDF, agree with Crossref, and support the title in the original text. */
export function verifiedReferenceTitle(
  candidate: string,
  pdfText: string,
  pdfDoi: string,
  work: CrossrefWork | null,
): string {
  const doiKey = (value: string) => value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/[.,;]+$/, "").toLowerCase();
  if (!work || !pdfDoi || doiKey(work.doi) !== doiKey(pdfDoi)) return "";
  if (titleLooksTruncated(work.title) || isScannedPdfText(pdfText) ||
      !titleKey(pdfText.slice(0, PDF_TITLE_CHECK_PREFIX_CHARS)).includes(titleKey(work.title))) return "";
  const key = titleKey(candidate);
  const complete = titleKey(work.title);
  if (!key || (key !== complete && !complete.startsWith(`${key} `))) return "";
  return work.title.trim();
}
