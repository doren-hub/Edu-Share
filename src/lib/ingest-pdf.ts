import { createAdminClient } from "@/lib/supabase/admin";
import { chunkText } from "@/lib/chunk-text";
import { embedTexts, openAiEmbeddingsEnabled } from "@/lib/embeddings";
import { extractPdfTextByPage, guessPdfPageForChunk } from "@/lib/pdf-text-by-page";
import { sanitizeExtractedPdfText } from "@/lib/sanitize-pdf-text";
import { stripReferencesSection } from "@/lib/strip-references-section";

export async function ingestPdfForTest(params: {
  testId: string;
  storagePath: string;
}): Promise<void> {
  const admin = createAdminClient();
  const { data: file, error: dlErr } = await admin.storage
    .from("pdfs")
    .download(params.storagePath);
  if (dlErr || !file) {
    throw new Error(dlErr?.message || "PDFの取得に失敗しました");
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const pdfParse = (await import("pdf-parse")).default as (
    b: Buffer,
  ) => Promise<{ text: string }>;

  let chunks: string[];
  let pdfPages: (number | null)[];

  try {
    const pageTexts = await extractPdfTextByPage(buf);
    if (pageTexts.length > 0) {
      const joined = pageTexts.map((t) => t.replace(/\r\n/g, "\n")).join("\n");
      const body = stripReferencesSection(joined);
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

  await admin.from("document_chunks").delete().eq("test_id", params.testId);

  if (chunks.length === 0) {
    const processingError =
      "PDFから本文テキストを自動抽出できませんでした（画像のみ・スキャンなどの可能性）。テキストがコピーできるPDFへの差し替えを推奨します。「テスト開始」による新規出題はできません。";
    const upd = await admin
      .from("tests")
      .update({
        processing_status: "ready",
        processing_error: processingError,
      })
      .eq("id", params.testId);
    if (upd.error) throw new Error(upd.error.message);
    return;
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

  const batchRows = 80;
  for (let i = 0; i < chunks.length; i += batchRows) {
    const slice = chunks.slice(i, i + batchRows);
    const rows = slice.map((content, j) => {
      const chunk_index = i + j;
      const pdf_page = pdfPages[chunk_index] ?? null;
      return {
        test_id: params.testId,
        chunk_index,
        content,
        ...(pdf_page != null ? { pdf_page } : {}),
        embedding: useEmb ? embeddings[chunk_index] : null,
      };
    });

    let ins = await admin.from("document_chunks").insert(rows);
    if (ins.error && /pdf_page|column|schema cache|PGRST/i.test(ins.error.message)) {
      const rowsLegacy = rows.map((row) => {
        const { pdf_page: _p, ...rest } = row as {
          pdf_page?: number | null;
          test_id: string;
          chunk_index: number;
          content: string;
          embedding: number[] | null;
        };
        return rest;
      });
      ins = await admin.from("document_chunks").insert(rowsLegacy);
    }
    if (ins.error) throw new Error(ins.error.message);
  }

  const upd = await admin
    .from("tests")
    .update({
      processing_status: "ready",
      processing_error: null,
    })
    .eq("id", params.testId);
  if (upd.error) throw new Error(upd.error.message);
}
