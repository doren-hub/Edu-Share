import { createAdminClient } from "@/lib/supabase/admin";
import { getObjectBytes } from "@/lib/object-storage";
import { chunkText } from "@/lib/chunk-text";
import { embedTexts, openAiEmbeddingsEnabled } from "@/lib/embeddings";
import { extractPdfTextByPage, guessPdfPageForChunk } from "@/lib/pdf-text-by-page";
import { sanitizeExtractedPdfText } from "@/lib/sanitize-pdf-text";
import { stripReferencesSection } from "@/lib/strip-references-section";

export async function ingestPdfForTest(params: {
  testId: string;
  storagePath: string;
  processingToken: string;
}): Promise<void> {
  const admin = createAdminClient();
  const buf = Buffer.from(await getObjectBytes(params.storagePath));
  const pdfParse = (await import("pdf-parse")).default as (
    b: Buffer,
  ) => Promise<{ text: string }>;

  let chunks: string[];
  let pdfPages: (number | null)[];

  try {
    const pageTexts = await extractPdfTextByPage(buf);
    if (pageTexts.length > 0) {
      const joined = pageTexts.map((t) => t.replace(/\r\n/g, "\n")).join("\n");
      const sanitized = sanitizeExtractedPdfText(joined);
      const body = stripReferencesSection(sanitized);
      chunks = chunkText(body);
      pdfPages = chunks.map((c) => guessPdfPageForChunk(c, pageTexts));
    } else {
      throw new Error("no pages");
    }
  } catch {
    let text: string;
    try {
      const parsed = await pdfParse(buf);
      text = sanitizeExtractedPdfText(parsed.text ?? "");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `PDFの解析に失敗しました（暗号化PDFや破損ファイルの可能性があります）: ${msg}`,
      );
    }
    chunks = chunkText(stripReferencesSection(text));
    pdfPages = chunks.map(() => null);
  }

  const useEmb = openAiEmbeddingsEnabled();
  const embeddings: number[][] = [];
  if (useEmb) {
    const batchSize = 32;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const part = chunks.slice(i, i + batchSize);
      const emb = await embedTexts(part);
      embeddings.push(...emb);
    }
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `埋め込みの件数がチャンクと一致しません（${embeddings.length}/${chunks.length}）。OpenAI API のエラーを確認してください。`,
      );
    }
  }

  // One transaction replaces chunks and publishes the new PDF only after all
  // extraction/embedding calls have succeeded. Never fall back to delete/insert.
  const rows = chunks.map((content, chunk_index) => ({
    chunk_index,
    content,
    pdf_page: pdfPages[chunk_index] ?? null,
    embedding: useEmb ? JSON.stringify(embeddings[chunk_index]) : null,
  }));
  const { error } = await admin.rpc("replace_test_pdf_chunks", {
    p_test_id: params.testId,
    p_processing_token: params.processingToken,
    p_storage_path: params.storagePath,
    p_chunks: rows,
    p_processing_error: chunks.length === 0
      ? "PDFから本文テキストを自動抽出できませんでした（画像のみ・スキャンなどの可能性）。テキストがコピーできるPDFへの差し替えを推奨します。「テスト開始」による新規出題はできません。"
      : null,
  });
  if (error) throw new Error(error.message);
}
