import { join } from "node:path";
import { sanitizeExtractedPdfText } from "@/lib/sanitize-pdf-text";

/**
 * PDF.js でページごとのプレーンテキストを取得（取り込み・ページ推定用）。
 */
export async function extractPdfTextByPage(buffer: Buffer): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const workerPath = join(
    process.cwd(),
    "node_modules",
    "pdfjs-dist",
    "legacy",
    "build",
    "pdf.worker.min.mjs",
  );
  pdfjs.GlobalWorkerOptions.workerSrc = workerPath;

  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const out: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const textContent = await page.getTextContent();
    const parts: string[] = [];
    for (const it of textContent.items) {
      if (typeof it !== "object" || !it || !("str" in it)) continue;
      const s = (it as { str?: string }).str;
      if (typeof s === "string" && s.length > 0) parts.push(s);
    }
    out.push(sanitizeExtractedPdfText(parts.join("")));
  }
  return out;
}

/**
 * チャンク本文が主にどのページ由来か、先頭一致で推定（1 始まり）。
 */
export function guessPdfPageForChunk(
  chunk: string,
  pageTexts: readonly string[],
): number | null {
  const key = chunk.replace(/\s+/g, " ").trim();
  if (key.length < 10) return null;
  const needle = key.slice(0, Math.min(120, key.length)).toLowerCase();
  const n2 = needle.slice(0, Math.min(60, needle.length));
  for (let p = 0; p < pageTexts.length; p++) {
    const pt = pageTexts[p]!.replace(/\s+/g, " ").trim().toLowerCase();
    if (pt.length < 8) continue;
    if (pt.includes(n2)) return p + 1;
  }
  return null;
}
