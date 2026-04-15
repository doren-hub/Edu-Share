import { join } from "node:path";
import type { SourcePdfHighlightRect } from "@/lib/types";
import {
  collectPdfRectsPerSliceInPdfSpace,
  findMatchInItemWindows,
  type TextItemLike,
} from "@/lib/pdf-highlight-geometry";

function textItemsFromTextContent(textContent: { items: unknown[] }): TextItemLike[] {
  const items: TextItemLike[] = [];
  for (const it of textContent.items) {
    if (typeof it !== "object" || !it || !("str" in it)) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.str !== "string") continue;
    if (!Array.isArray(o.transform)) continue;
    if (typeof o.width !== "number") continue;
    const height = typeof o.height === "number" ? o.height : 0;
    items.push({
      str: o.str,
      transform: o.transform as number[],
      width: o.width,
      height,
    });
  }
  return items;
}

/**
 * 1 ページの items とフレーズから、PDF 空間のハイライト矩形列を返す（失敗時 null）。
 */
function tryResolvePhraseOnPage(
  pageNum: number,
  items: TextItemLike[],
  phrase: string,
): SourcePdfHighlightRect[] | null {
  const found = findMatchInItemWindows(items, phrase);
  if (!found) return null;
  const pdfRects = collectPdfRectsPerSliceInPdfSpace(
    found.chunk,
    found.u,
    found.v,
    found.joinMode,
  );
  if (pdfRects.length === 0) return null;
  return pdfRects.map((pdfRect) => ({ page: pageNum, pdfRect }));
}

export type ResolvePhraseHighlightsResult = {
  rects: SourcePdfHighlightRect[];
  matchedPhrase: string;
};

/**
 * PDF バッファと検索フレーズ候補（長い順）から、最初に解決できたハイライトを返す。
 * sourcePdfPage が妥当なときはそのページを先に試し、ダメなら全ページを走査する。
 */
export async function resolvePhraseHighlightsInPdf(
  pdfBuffer: Buffer,
  phrases: string[],
  sourcePdfPage: number | undefined,
  maxPages = 60,
): Promise<ResolvePhraseHighlightsResult | null> {
  if (phrases.length === 0) return null;

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

  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true }).promise;
  const n = Math.min(doc.numPages, maxPages);

  const hint =
    sourcePdfPage != null && Number.isFinite(sourcePdfPage) && sourcePdfPage >= 1 && sourcePdfPage <= n
      ? Math.floor(sourcePdfPage)
      : null;

  for (const phrase of phrases) {
    if (hint != null) {
      const page = await doc.getPage(hint);
      const items = textItemsFromTextContent(await page.getTextContent());
      const hit = tryResolvePhraseOnPage(hint, items, phrase);
      if (hit) return { rects: hit, matchedPhrase: phrase };
    }

    for (let pageNum = 1; pageNum <= n; pageNum++) {
      if (hint != null && pageNum === hint) continue;
      const page = await doc.getPage(pageNum);
      const items = textItemsFromTextContent(await page.getTextContent());
      const hit = tryResolvePhraseOnPage(pageNum, items, phrase);
      if (hit) return { rects: hit, matchedPhrase: phrase };
    }
  }

  return null;
}
