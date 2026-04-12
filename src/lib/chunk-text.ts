const MAX = 900;
const OVERLAP = 120;

export function chunkText(raw: string): string[] {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return [];

  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + MAX);
    let slice = text.slice(i, end);
    if (end < text.length) {
      const lastPeriod = slice.lastIndexOf("。");
      const lastDot = slice.lastIndexOf(". ");
      const cut = Math.max(lastPeriod, lastDot);
      if (cut > MAX * 0.4) {
        slice = slice.slice(0, cut + 1);
      }
    }
    const trimmed = slice.trim();
    if (trimmed.length > 40) chunks.push(trimmed);
    i += Math.max(1, slice.length - OVERLAP);
  }
  return chunks;
}
