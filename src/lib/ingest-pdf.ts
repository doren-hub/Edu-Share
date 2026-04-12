import { createAdminClient } from "@/lib/supabase/admin";
import { chunkText } from "@/lib/chunk-text";
import { embedTexts } from "@/lib/embeddings";

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
  const { text } = await pdfParse(buf);
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error("PDFから十分なテキストを抽出できませんでした");
  }

  await admin.from("document_chunks").delete().eq("test_id", params.testId);

  const useEmb = !!process.env.OPENAI_API_KEY;
  const embeddings: number[][] = [];
  if (useEmb) {
    const batchSize = 32;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const part = chunks.slice(i, i + batchSize);
      const emb = await embedTexts(part);
      embeddings.push(...emb);
    }
  }

  const batchRows = 80;
  for (let i = 0; i < chunks.length; i += batchRows) {
    const slice = chunks.slice(i, i + batchRows);
    const rows = slice.map((content, j) => {
      const chunk_index = i + j;
      return {
        test_id: params.testId,
        chunk_index,
        content,
        embedding: useEmb ? embeddings[chunk_index] : null,
      };
    });

    const ins = await admin.from("document_chunks").insert(rows);
    if (ins.error) throw new Error(ins.error.message);
  }

  const upd = await admin
    .from("tests")
    .update({ processing_status: "ready", processing_error: null })
    .eq("id", params.testId);
  if (upd.error) throw new Error(upd.error.message);
}
