/** 論文 PDF の元ファイル名。パスを落とし、拡張子の有無と大文字小文字は同一とみなす */
export function normalizePdfFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (!base) return "";
  const lower = base.toLowerCase();
  return lower.endsWith(".pdf") ? lower : `${lower}.pdf`;
}

export function pdfFilenamesEqual(a: string, b: string): boolean {
  const na = normalizePdfFilename(a);
  const nb = normalizePdfFilename(b);
  return Boolean(na) && na === nb;
}
