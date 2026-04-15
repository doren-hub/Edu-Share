/**
 * 論文・レポートの「参考文献」ブロック以降はテスト出題対象外とする。
 * 本文中の語としての「参考文献」は、改行＋見出し風の行に限定して切り詰める。
 */

const REF_HEADING_LINE =
  /(?:^|\n)[\s\u3000]*(参考文献|【\s*参考文献\s*】|参照文献|References\b|REFERENCES|Bibliography)\b[\s\u3000]*(?:\n|$)/iu;

/**
 * 全文テキストから、最初の参考文献見出し行より前だけを返す（PDF 取り込み時用）。
 */
export function stripReferencesSection(text: string): string {
  const s = text.replace(/\r\n/g, "\n");
  const m = REF_HEADING_LINE.exec(s);
  if (!m || m.index === undefined) return s.trim();
  return s.slice(0, m.index).trim();
}

/**
 * 既存チャンクが参考文献ブロックそのものか（取り込みが旧仕様のときの出題除外用）。
 */
export function isReferencesBibliographyChunk(content: string): boolean {
  const head = content.trimStart().slice(0, 120);
  return /^(参考文献|【\s*参考文献\s*】|参照文献|References\b|REFERENCES|Bibliography)\b/u.test(
    head,
  );
}
