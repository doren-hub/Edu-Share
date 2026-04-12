import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestPdfForTest } from "@/lib/ingest-pdf";

export const runtime = "nodejs";

const schema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  source_type: z.enum(["school", "expert"]),
  source_name: z.string().min(1).max(200),
  document_type: z.enum(["past_exam", "paper"]).default("past_exam"),
});

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "PDFファイルが必要です" }, { status: 400 });
  }
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "PDFのみアップロードできます" }, { status: 400 });
  }

  const parsed = schema.safeParse({
    title: String(form.get("title") ?? ""),
    description: form.get("description")
      ? String(form.get("description"))
      : undefined,
    source_type: String(form.get("source_type") ?? ""),
    source_name: String(form.get("source_name") ?? ""),
    document_type: form.get("document_type")
      ? String(form.get("document_type"))
      : "past_exam",
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "入力が不正です", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { title, description, source_type, source_name, document_type } =
    parsed.data;

  const testId = crypto.randomUUID();
  const storagePath = `${user.id}/${testId}.pdf`;

  const { data: inserted, error: insErr } = await supabase
    .from("tests")
    .insert({
      id: testId,
      title,
      description: description ?? null,
      pdf_storage_path: storagePath,
      source_type,
      source_name,
      document_type,
      uploaded_by: user.id,
      processing_status: "pending",
    })
    .select("id")
    .single();

  if (insErr || !inserted) {
    return NextResponse.json(
      { error: insErr?.message || "テスト作成に失敗しました" },
      { status: 500 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: upErr } = await supabase.storage
    .from("pdfs")
    .upload(storagePath, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (upErr) {
    const admin = createAdminClient();
    await admin.from("tests").delete().eq("id", testId);
    return NextResponse.json(
      { error: upErr.message || "ストレージへのアップロードに失敗しました" },
      { status: 500 },
    );
  }

  try {
    await ingestPdfForTest({ testId, storagePath });
  } catch (e) {
    const admin = createAdminClient();
    await admin
      .from("tests")
      .update({
        processing_status: "failed",
        processing_error: e instanceof Error ? e.message : "処理に失敗しました",
      })
      .eq("id", testId);

    return NextResponse.json(
      {
        error: "PDFの取り込みに失敗しました",
        details: e instanceof Error ? e.message : String(e),
        testId,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ testId });
}
