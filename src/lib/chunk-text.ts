const MAX = 900;
const OVERLAP = 120;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 指定インデックスがサロゲートペアの分割位置（high と low の間）である場合、
 * ペアを壊さないよう境界を 1 つ戻して high surrogate の手前に揃える。
 */
function adjustSurrogateBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  if (
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  ) {
    return index - 1;
  }
  return index;
}

export function chunkText(raw: string): string[] {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return [];

  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + MAX);
    end = adjustSurrogateBoundary(text, end);
    let slice = text.slice(i, end);

    if (end < text.length) {
      const lastPeriod = slice.lastIndexOf("。");
      const lastDot = slice.lastIndexOf(". ");
      const cut = Math.max(lastPeriod, lastDot);
      if (cut > MAX * 0.4) {
        const cutEnd = adjustSurrogateBoundary(text, i + cut + 1);
        slice = text.slice(i, cutEnd);
      }
    }
    const trimmed = slice.trim();
    if (trimmed.length > 15) chunks.push(trimmed);

    let nextStep = Math.max(1, slice.length - OVERLAP);
    let nextI = i + nextStep;
    nextI = adjustSurrogateBoundary(text, nextI);
    if (nextI <= i) {
      nextI = i + Math.max(1, slice.length);
      nextI = adjustSurrogateBoundary(text, nextI);
      if (nextI <= i) nextI = end;
    }
    i = nextI;
  }

  if (chunks.length === 0 && text.length > 50) {
    let j = 0;
    while (j < text.length) {
      let end = Math.min(text.length, j + MAX);
      end = adjustSurrogateBoundary(text, end);
      const piece = text.slice(j, end).trim();
      if (piece.length > 10) chunks.push(piece);

      let nextJ = j + (MAX - OVERLAP);
      nextJ = adjustSurrogateBoundary(text, nextJ);
      if (nextJ <= j) nextJ = j + 1;
      j = nextJ;
    }
  }

  return chunks;
}
