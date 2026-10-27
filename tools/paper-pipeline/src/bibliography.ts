import type { CrossrefWork } from "./crossref.ts";
import { isScannedPdfText, PDF_TITLE_CHECK_PREFIX_CHARS } from "./pdf-grounding.ts";

/** Standalone UI labels are never bibliographic values. */
export function isBibliographyLabel(value: string): boolean {
  const text = value.replace(/[:：\s]+$/g, "").trim();
  return /^(doi|journal|authors?|title|venue|publication|published in|publication year|year|著者|掲載先|掲載誌|タイトル|論文タイトル|発表年|年|不明|unknown|n\/a)$/i.test(text);
}

export function authorsLookInvalid(value: string): boolean {
  const text = value.trim();
  return !text || /^DOI\s*[:：]?\s*10\./i.test(text) ||
    text.split(/[,;·⋅•\n]/).some(part => isBibliographyLabel(part));
}

function titleKey(value: string): string {
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
  const continuation = (text: string) =>
    /^(?:(?:for|of|with|based|using|and|in|on)\b|(?:a\s+)?(?:tool|framework|approach|method|model|system)\s+(?:for|of|with|to)\b)/i.test(text) &&
    !/abstract|keywords|doi|@|\d|\b(?:department|university|institute|school|faculty|laboratory|centre|center|hospital|consortium|association)\b/i.test(text);
  return lines.some((line, index) => {
    const text = titleKey(line);
    if (text.startsWith(`${key} `)) return continuation(text.slice(key.length + 1));
    return text === key && continuation(lines[index + 1] ?? "");
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
