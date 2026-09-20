/** Files タブはトグルなので、選択済みや直前のクリックでは押さない */
export const FILES_TAB_CLICK_GAP_MS = 15_000;

export function filesTabClickAllowed(opts: {
  alreadySelected: boolean;
  lastClickAt: number;
  now: number;
  gapMs?: number;
}): boolean {
  if (opts.alreadySelected) return false;
  return opts.now - opts.lastClickAt >= (opts.gapMs ?? FILES_TAB_CLICK_GAP_MS);
}

/** SciSpace フォルダの Files 表か、ノートのチャット/Home かを本文から分ける。 */
export function looksLikeSciSpaceFilesTable(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  if (!/Upload PDFs/i.test(t)) return false;
  if (!/Files\s*\(\d+/i.test(t)) return false;
  if (/Uploaded on/i.test(t)) return true;
  if (/\bTL;DR\b/.test(t) && /\.pdf\b/i.test(t)) return true;
  if (/Files\s*\(0\)/i.test(t) && /drag|drop|no files|empty/i.test(t)) return true;
  // 絞り込み 0 件でも Files 表（Sort と Upload PDFs がある）。タブを押すと閉じる
  if (/\bSort\b/i.test(t) && /no results|Try searching/i.test(t)) return true;
  if (/\bSort\b/i.test(t) && /\bNotebooks\s*\(\d+\)/i.test(t)) return true;
  return false;
}

export function looksLikeSciSpaceChatHome(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  const hits = [/\bNew Chat\b/i, /\bHome\b/, /\bAgent Gallery\b/i, /\bChat with PDF\b/i].filter((r) =>
    r.test(t),
  ).length;
  if (hits < 3) return false;
  return !looksLikeSciSpaceFilesTable(t);
}
