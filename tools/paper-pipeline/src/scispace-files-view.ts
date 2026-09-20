/** SciSpace フォルダの Files 表か、ノートのチャット/Home かを本文から分ける。 */

export function looksLikeSciSpaceFilesTable(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  if (!/Upload PDFs/i.test(t)) return false;
  if (!/Files\s*\(\d+/i.test(t)) return false;
  if (/Uploaded on/i.test(t)) return true;
  if (/\bTL;DR\b/.test(t) && /\.pdf\b/i.test(t)) return true;
  if (/Files\s*\(0\)/i.test(t) && /drag|drop|no files|empty/i.test(t)) return true;
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
