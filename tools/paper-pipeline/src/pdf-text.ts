import { existsSync, readFileSync } from "node:fs";
import { firstLine, warn } from "./log.ts";

/**
 * PDF ファイルまたはバッファからプレーンテキストを取り出す。
 * 読み取り失敗時（破損・暗号化・パースエラー等）は警告を出して undefined を返す。
 * これにより、テキスト抽出不可のときにスキャン PDF と誤認してメタ情報を破棄するのを防ぐ。
 * 空バッファや空文字パスの場合は空文字列 "" を返す。
 */
export async function extractPdfText(pdfPathOrBuffer: string | Buffer): Promise<string | undefined> {
  try {
    let buf: Buffer;
    if (typeof pdfPathOrBuffer === "string") {
      if (!pdfPathOrBuffer) return "";
      if (!existsSync(pdfPathOrBuffer)) {
        warn(`PDFファイルが見つかりません: ${pdfPathOrBuffer}`);
        return undefined;
      }
      buf = readFileSync(pdfPathOrBuffer);
    } else {
      buf = pdfPathOrBuffer;
    }
    if (!buf || buf.length === 0) return "";

    // Node.js の Buffer pool による byteOffset ずれを回避するため、
    // 純粋な Uint8Array (constructor === Uint8Array, byteOffset === 0) にコピーして渡す
    const uint8 = new Uint8Array(buf.length);
    uint8.set(buf);

    // pdf-parse は CJS のため default または名前付き解決
    const mod = await import("pdf-parse");
    const pdfParse = (mod.default ?? mod) as (
      dataBuffer: Buffer | Uint8Array,
      options?: { max?: number },
    ) => Promise<{ text: string; numpages: number }>;

    const data = await pdfParse(uint8);
    return data?.text ?? "";
  } catch (err) {
    warn(`PDFテキスト抽出に失敗しました: ${firstLine(err)}`);
    return undefined;
  }
}

