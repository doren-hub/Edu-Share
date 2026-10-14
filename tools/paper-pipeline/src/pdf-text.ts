import { existsSync, readFileSync } from "node:fs";

/**
 * PDF ファイルまたはバッファからプレーンテキストを取り出す。
 * 失敗時やテキストが存在しない場合は空文字列を返す。
 */
export async function extractPdfText(pdfPathOrBuffer: string | Buffer): Promise<string> {
  try {
    let buf: Buffer;
    if (typeof pdfPathOrBuffer === "string") {
      if (!pdfPathOrBuffer || !existsSync(pdfPathOrBuffer)) return "";
      buf = readFileSync(pdfPathOrBuffer);
    } else {
      buf = pdfPathOrBuffer;
    }
    if (!buf || buf.length === 0) return "";

    // pdf-parse は CJS のため default または名前付き解決
    const mod = await import("pdf-parse");
    const pdfParse = (mod.default ?? mod) as (
      dataBuffer: Buffer,
      options?: { max?: number },
    ) => Promise<{ text: string; numpages: number }>;

    const data = await pdfParse(buf);
    return data?.text ?? "";
  } catch {
    return "";
  }
}
