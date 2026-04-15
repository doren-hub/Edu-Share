/**
 * PDF テキストレイヤーからのハイライト幾何計算（クライアント・サーバー共通）。
 *
 * - 照合: NFKC 等は normForMatch のみ。元の item.str は変更しない。
 * - 座標: transform + width + 元 str のコード単位区間から PDF ユーザー空間の矩形を算出。
 * - 照合位置の探索: ページ全体の indexOf は行わず、連続 items の窓内で norm 一致を探す。
 */

export type TextItemLike = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

export type JoinMode = "tight" | "spaced";

/** 1 ページあたり走査する連続 TextItem の最大個数 */
export const MAX_ITEM_WINDOW = 40;

export function normForMatch(s: string): string {
  try {
    return s
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  } catch {
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  }
}

function advanceWeightForChar(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0xfeff) return 0;
  if (c >= 0x300 && c <= 0x36f) return 0;
  if (c >= 0x20d0 && c <= 0x20ff) return 0;
  return 1;
}

export function inkAdvanceSubstringStrict(
  str: string,
  width: number,
  a: number,
  b: number,
): { x0: number; x1: number } {
  const n = str.length;
  if (n === 0 || !(width > 0) || b <= a) return { x0: 0, x1: 0 };
  const aa = Math.max(0, Math.min(a, n));
  const bb = Math.max(aa, Math.min(b, n));
  if (bb <= aa) return { x0: 0, x1: 0 };

  const wPart: number[] = [];
  for (let k = 0; k < n; k++) wPart.push(advanceWeightForChar(str[k]!));
  let totalW = wPart.reduce((x, y) => x + y, 0);
  if (totalW < 1e-6) totalW = n;

  const cum: number[] = new Array(n + 1);
  cum[0] = 0;
  for (let k = 0; k < n; k++) cum[k + 1] = cum[k]! + (wPart[k]! / totalW) * width;

  let lo = aa;
  let hi = bb;
  while (lo < hi && /\s/u.test(str[lo]!)) lo++;
  while (hi > lo && /\s/u.test(str[hi - 1]!)) hi--;
  if (hi <= lo) return { x0: 0, x1: 0 };
  return { x0: cum[lo]!, x1: cum[hi]! };
}

function verticalEmMetrics(item: TextItemLike, fontH: number): { ascent: number; descent: number } {
  let emH: number;
  if (item.height > 0 && item.height <= fontH * 0.82) {
    emH = item.height;
  } else if (item.height > 0) {
    emH = Math.min(item.height, fontH * 0.92);
    if (emH > fontH * 0.88) emH = fontH * 0.88;
  } else {
    emH = fontH * 0.86;
  }
  emH = Math.max(emH, fontH * 0.36);
  const ascent = emH * 0.73;
  const descent = emH - ascent;
  return { ascent, descent };
}

function verticalEmMetricsHighlight(item: TextItemLike, fontH: number): { ascent: number; descent: number } {
  const { ascent, descent } = verticalEmMetrics(item, fontH);
  const shrink = 0.86;
  return { ascent: ascent * shrink, descent: descent * shrink };
}

function pdfRectFromLocalXBand(
  m: number[],
  x0: number,
  x1: number,
  ascent: number,
  descent: number,
): [number, number, number, number] {
  const localCorners: [number, number][] = [
    [x0, descent],
    [x1, descent],
    [x1, -ascent],
    [x0, -ascent],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of localCorners) {
    const x = m[0]! * lx + m[2]! * ly + m[4]!;
    const y = m[1]! * lx + m[3]! * ly + m[5]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

export function pdfRectForHighlightRange(
  item: TextItemLike,
  s: number,
  e: number,
): [number, number, number, number] | null {
  const m = item.transform;
  const fontH = Math.hypot(m[2]!, m[3]!);
  const n = item.str.length;
  const a = Math.max(0, Math.min(s, n));
  const b = Math.max(a, Math.min(e, n));
  if (b <= a) return null;
  const { x0, x1 } = inkAdvanceSubstringStrict(item.str, item.width, a, b);
  if (!(x1 > x0)) return null;
  const { ascent, descent } = verticalEmMetricsHighlight(item, fontH);
  return pdfRectFromLocalXBand(m, x0, x1, ascent, descent);
}

export function mapTightRangeToSlices(
  chunk: TextItemLike[],
  u: number,
  v: number,
): Array<{ item: TextItemLike; s: number; e: number }> {
  const out: Array<{ item: TextItemLike; s: number; e: number }> = [];
  let pos = 0;
  for (const item of chunk) {
    const len = item.str.length;
    const end = pos + len;
    if (v <= pos) break;
    if (u < end) {
      const s = Math.max(0, u - pos);
      const e = Math.min(len, v - pos);
      if (e > s) out.push({ item, s, e });
    }
    pos = end;
  }
  return out;
}

export function mapSpacedRangeToSlices(
  chunk: TextItemLike[],
  u: number,
  v: number,
): Array<{ item: TextItemLike; s: number; e: number }> {
  const out: Array<{ item: TextItemLike; s: number; e: number }> = [];
  let base = 0;
  for (let i = 0; i < chunk.length; i++) {
    const it = chunk[i]!;
    const start = base;
    const end = base + it.str.length;
    if (v > start && u < end) {
      const s = Math.max(0, u - start);
      const e = Math.min(it.str.length, v - start);
      if (e > s) out.push({ item: it, s, e });
    }
    base = end;
    if (i < chunk.length - 1) base += 1;
  }
  return out;
}

function parseSlashWrappedRegex(needle: string): RegExp | null {
  const t = needle.trim();
  if (t.length < 3 || !t.startsWith("/")) return null;
  const last = t.lastIndexOf("/");
  if (last <= 0) return null;
  const body = t.slice(1, last);
  const flags = t.slice(last + 1);
  if (body.length === 0) return null;
  if (!/^[a-z]*$/i.test(flags)) return null;
  try {
    const f = flags.includes("g") ? flags : `${flags}g`;
    return new RegExp(body, f);
  } catch {
    return null;
  }
}

function minimalNormEqualSpan(merged: string, phrase: string): [number, number] | null {
  const pn = normForMatch(phrase);
  if (pn.length < 6) return null;
  if (!normForMatch(merged).includes(pn)) return null;
  const n = merged.length;
  const loEq = Math.max(1, pn.length - 48);
  const hiEq = Math.min(n, pn.length + 96);
  let best: [number, number] | null = null;
  let bestLen = Infinity;
  for (let L = loEq; L <= hiEq; L++) {
    for (let u = 0; u + L <= n; u++) {
      if (normForMatch(merged.slice(u, u + L)) !== pn) continue;
      if (L < bestLen) {
        bestLen = L;
        best = [u, u + L];
      }
    }
  }
  if (best) return best;

  const maxL = Math.min(n, Math.max(pn.length + 72, 160));
  const loIn = Math.max(4, Math.floor(pn.length * 0.82));
  for (let L = loIn; L <= maxL; L++) {
    for (let u = 0; u + L <= n; u++) {
      if (normForMatch(merged.slice(u, u + L)).includes(pn)) {
        return [u, u + L];
      }
    }
  }
  return null;
}

function firstRegexSpan(merged: string, re: RegExp): [number, number] | null {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const m = r.exec(merged);
  if (!m || m[0].length === 0) return null;
  return [m.index, m.index + m[0].length];
}

function rawSpanInMerged(merged: string, phrase: string): [number, number] | null {
  const asRe = parseSlashWrappedRegex(phrase);
  if (asRe) return firstRegexSpan(merged, asRe);
  return minimalNormEqualSpan(merged, phrase);
}

function minimalCompactSpan(merged: string, pc: string): [number, number] | null {
  if (pc.length < 6) return null;
  const flat = merged.replace(/\s+/g, "").toLowerCase();
  if (!flat.includes(pc)) return null;
  const n = merged.length;
  const maxL = Math.min(n, Math.max(pc.length + 48, 120));
  const minL = Math.max(6, Math.floor(pc.length * 0.85));
  for (let L = minL; L <= maxL; L++) {
    for (let u = 0; u + L <= n; u++) {
      const slice = merged.slice(u, u + L);
      if (slice.replace(/\s+/g, "").toLowerCase().includes(pc)) return [u, u + L];
    }
  }
  return null;
}

export function findMatchInItemWindows(
  items: TextItemLike[],
  phrase: string,
): { chunk: TextItemLike[]; u: number; v: number; joinMode: JoinMode } | null {
  const n = items.length;
  const maxLen = Math.min(MAX_ITEM_WINDOW, n);
  for (let len = 1; len <= maxLen; len++) {
    for (let i = 0; i + len <= n; i++) {
      const chunk = items.slice(i, i + len);

      const mergedT = chunk.map((x) => x.str).join("");
      let span = rawSpanInMerged(mergedT, phrase);
      if (span) return { chunk, u: span[0], v: span[1], joinMode: "tight" };

      const mergedS = chunk.map((x) => x.str).join(" ");
      span = rawSpanInMerged(mergedS, phrase);
      if (span) return { chunk, u: span[0], v: span[1], joinMode: "spaced" };
    }
  }

  const pc = phrase.replace(/\s+/g, "").toLowerCase();
  if (pc.length >= 6) {
    for (let len = 1; len <= maxLen; len++) {
      for (let i = 0; i + len <= n; i++) {
        const chunk = items.slice(i, i + len);
        const mergedT = chunk.map((x) => x.str).join("");
        const span = minimalCompactSpan(mergedT, pc);
        if (span) return { chunk, u: span[0], v: span[1], joinMode: "tight" };
      }
    }
  }

  return null;
}

/**
 * マッチ区間を各 TextItem の部分 [s,e) ごとに 1 矩形にまとめる。
 * コード単位で大量の div を重ねると半透明が積み上がり図のような濃色ブロックになるため、
 * 同一 text item 内は 1 帯にまとめる（隣接ランは item 境界で分割される）。
 */
/** 1 ラン内の改行で区切り、複数行を 1 つの巨大帯にしない */
function splitSliceByLineBreaks(
  item: TextItemLike,
  s: number,
  e: number,
): Array<{ item: TextItemLike; s: number; e: number }> {
  const out: Array<{ item: TextItemLike; s: number; e: number }> = [];
  let seg = s;
  for (let k = s; k < e; k++) {
    const c = item.str[k]!;
    if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") {
      if (k > seg) out.push({ item, s: seg, e: k });
      if (c === "\r" && item.str[k + 1] === "\n") k++;
      seg = k + 1;
    }
  }
  if (seg < e) out.push({ item, s: seg, e });
  return out.length > 0 ? out : [{ item, s, e }];
}

export function collectPdfRectsPerSliceInPdfSpace(
  chunk: TextItemLike[],
  u: number,
  v: number,
  joinMode: JoinMode,
): [number, number, number, number][] {
  const slices =
    joinMode === "tight" ? mapTightRangeToSlices(chunk, u, v) : mapSpacedRangeToSlices(chunk, u, v);
  const rects: [number, number, number, number][] = [];
  for (const { item, s, e } of slices) {
    for (const sub of splitSliceByLineBreaks(item, s, e)) {
      const pr = pdfRectForHighlightRange(sub.item, sub.s, sub.e);
      if (pr) rects.push(pr);
    }
  }
  return rects;
}

/** @deprecated 互換用。内部はスライス単位の矩形に統一 */
export function collectPdfRectsPerCodeUnitInPdfSpace(
  chunk: TextItemLike[],
  u: number,
  v: number,
  joinMode: JoinMode,
): [number, number, number, number][] {
  return collectPdfRectsPerSliceInPdfSpace(chunk, u, v, joinMode);
}

export function viewportCssRectFromPdf(
  viewport: { convertToViewportRectangle: (r: number[]) => number[] },
  pdfRect: [number, number, number, number],
): { left: number; top: number; width: number; height: number } {
  const [a, b, c, d] = viewport.convertToViewportRectangle(pdfRect);
  const left = Math.min(a, c);
  const top = Math.min(b, d);
  let width = Math.abs(c - a);
  let height = Math.abs(d - b);
  if (width > 0 && width < 0.25) width = 0.25;
  if (height > 0 && height < 0.25) height = 0.25;
  return { left, top, width, height };
}

function intersectionAreaViewport(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
): number {
  const x0 = Math.max(a.left, b.left);
  const y0 = Math.max(a.top, b.top);
  const x1 = Math.min(a.left + a.width, b.left + b.width);
  const y1 = Math.min(a.top + a.height, b.top + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

function rectAreaViewport(r: { left: number; top: number; width: number; height: number }): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function unionViewportRect(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const x0 = Math.min(a.left, b.left);
  const y0 = Math.min(a.top, b.top);
  const x1 = Math.max(a.left + a.width, b.left + b.width);
  const y1 = Math.max(a.top + a.height, b.top + b.height);
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

function shouldMergeViewportHighlights(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
): boolean {
  const inter = intersectionAreaViewport(a, b);
  if (inter <= 0) return false;
  const u = unionViewportRect(a, b);
  const maxW = Math.max(a.width, b.width, 1e-6);
  const maxH = Math.max(a.height, b.height, 1e-6);
  // 左右段や離れた行を 1 矩形に結合しない（外接幅・高さが元の帯を大きく超える）
  if (u.width > maxW * 1.34 || u.height > maxH * 2.4) return false;
  const aa = rectAreaViewport(a);
  const ba = rectAreaViewport(b);
  const minA = Math.min(aa, ba);
  const unionA = aa + ba - inter;
  const overlapOnSmaller = inter / Math.max(minA, 1e-6);
  const iou = inter / Math.max(unionA, 1e-6);
  return overlapOnSmaller >= 0.18 || iou >= 0.22;
}

/**
 * 同一極性（正解／不正解）内で重なるハイライトを外接矩形にまとめ、div の重ね塗りで濃く濁るのを抑える。
 */
export function mergeOverlappingViewportHighlights<
  T extends { left: number; top: number; width: number; height: number; correct: boolean },
>(quads: T[]): T[] {
  const mergeOne = (group: T[]): T[] => {
    let g = group.map((x) => ({ ...x }));
    let changed = true;
    while (changed && g.length > 1) {
      changed = false;
      outer: for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const a = g[i]!;
          const b = g[j]!;
          if (!shouldMergeViewportHighlights(a, b)) continue;
          const u = unionViewportRect(a, b) as T;
          u.correct = a.correct;
          g = g.filter((_, k) => k !== i && k !== j);
          g.push(u);
          changed = true;
          break outer;
        }
      }
    }
    return g;
  };
  const ok = quads.filter((q) => q.correct);
  const ng = quads.filter((q) => !q.correct);
  return [...mergeOne(ok), ...mergeOne(ng)];
}

/** 1 行を大きく超える縦方向は PDF テキスト層の誤りが多いので、ページ高に対する上限でクリップ（中心維持） */
export function clampViewportHighlightHeight(
  r: { left: number; top: number; width: number; height: number },
  pageH: number,
  maxFrac = 0.07,
): { left: number; top: number; width: number; height: number } {
  const cap = pageH * maxFrac;
  if (!(r.height > cap)) return r;
  const mid = r.top + r.height / 2;
  return { ...r, height: cap, top: mid - cap / 2 };
}

/** ページ矩形へクリップ（右余白へはみ出す bbox を抑える） */
export function clipViewportHighlightToPage(
  r: { left: number; top: number; width: number; height: number },
  pageW: number,
  pageH: number,
): { left: number; top: number; width: number; height: number } | null {
  let { left, top, width, height } = r;
  if (!(width > 0 && height > 0)) return null;
  if (left < 0) {
    width += left;
    left = 0;
  }
  if (top < 0) {
    height += top;
    top = 0;
  }
  width = Math.min(width, pageW - left);
  height = Math.min(height, pageH - top);
  if (!(width > 0.08 && height > 0.08)) return null;
  return { left, top, width, height };
}

/** 明らかにページ全体を覆う誤検出や非テキスト用巨大 bbox を除外 */
export function isPlausibleViewportHighlight(
  r: { left: number; top: number; width: number; height: number },
  pageW: number,
  pageH: number,
): boolean {
  if (!(r.width > 0 && r.height > 0) || !Number.isFinite(r.left + r.top)) return false;
  if (r.width > pageW * 0.38 || r.height > pageH * 0.2) return false;
  if (r.left + r.width < -pageW * 0.05 || r.top + r.height < -pageH * 0.05) return false;
  if (r.left > pageW * 1.05 || r.top > pageH * 1.05) return false;
  if (r.left + r.width > pageW * 1.02) return false;
  // 2 段組の段間を横断（中央付近まで届く広い帯）
  if (
    r.width > pageW * 0.17 &&
    r.left < pageW * 0.48 &&
    r.left + r.width > pageW * 0.52 &&
    r.left + r.width < pageW * 0.94
  ) {
    return false;
  }
  return true;
}

/** クリップ・棄却・重複マージをまとめて適用（結果画面のオーバーレイ用） */
export function finalizeViewportHighlightsForPage<
  T extends { left: number; top: number; width: number; height: number; correct: boolean },
>(quads: T[], pageW: number, pageH: number): T[] {
  const clamped = quads.map((q) => {
    const r = clampViewportHighlightHeight(q, pageH);
    return { ...q, ...r };
  });
  const clipped: T[] = [];
  for (const q of clamped) {
    const c = clipViewportHighlightToPage(q, pageW, pageH);
    if (c) clipped.push({ ...q, ...c });
  }
  const kept = clipped.filter((q) => isPlausibleViewportHighlight(q, pageW, pageH));
  return mergeOverlappingViewportHighlights(kept);
}

export function collectViewportQuadsPerMatchedRun(
  chunk: TextItemLike[],
  u: number,
  v: number,
  viewport: { width: number; height: number; convertToViewportRectangle: (r: number[]) => number[] },
  joinMode: JoinMode,
): { left: number; top: number; width: number; height: number }[] {
  const pw = viewport.width;
  const ph = viewport.height;
  return collectPdfRectsPerSliceInPdfSpace(chunk, u, v, joinMode)
    .map((pr) => viewportCssRectFromPdf(viewport, pr))
    .map((css) => clampViewportHighlightHeight(css, ph))
    .filter((css) => isPlausibleViewportHighlight(css, pw, ph));
}

/** @deprecated collectViewportQuadsPerMatchedRun を使用 */
export function collectViewportQuadsPerCodeUnit(
  chunk: TextItemLike[],
  u: number,
  v: number,
  viewport: { width: number; height: number; convertToViewportRectangle: (r: number[]) => number[] },
  joinMode: JoinMode,
): { left: number; top: number; width: number; height: number }[] {
  return collectViewportQuadsPerMatchedRun(chunk, u, v, viewport, joinMode);
}
