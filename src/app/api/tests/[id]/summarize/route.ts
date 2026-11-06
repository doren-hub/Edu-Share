import { NextResponse } from "next/server";
import { llmRateLimitResponse } from "@/lib/llm-rate-limit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractPdfTextByPage } from "@/lib/pdf-text-by-page";
import { getObjectBytes } from "@/lib/object-storage";
import { summarizeByLlm } from "@/lib/pdf-summary.ts";

export const runtime = "nodejs";

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[。．.!?！？])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18);
}

function summarizeExtractive(raw: string): string {
  const sentences = splitSentences(raw);
  if (!sentences.length) return "";
  const picked: string[] = [];
  for (const s of sentences) {
    if (picked.length >= 3) break;
    picked.push(s.length > 220 ? `${s.slice(0, 217).trim()}...` : s);
  }
  const out = picked.join(" ");
  return out.length > 420 ? `${out.slice(0, 417).trim()}...` : out;
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: testId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  const limited = await llmRateLimitResponse("summarize", user.id);
  if (limited) return limited;

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      { error: "サーバー用の Supabase キーが未設定です" },
      { status: 500 },
    );
  }

  const { data: row, error: fetchErr } = await admin
    .from("tests")
    .select("id, uploaded_by, pdf_storage_path")
    .eq("id", testId)
    .single();
  if (fetchErr || !row) {
    return NextResponse.json({ error: "テストが見つかりません" }, { status: 404 });
  }
  if (row.uploaded_by !== user.id) {
    return NextResponse.json(
      { error: "要約できるのはアップロードしたユーザーのみです" },
      { status: 403 },
    );
  }

  let pdfBin: Uint8Array;
  try {
    pdfBin = await getObjectBytes(row.pdf_storage_path);
  } catch (error) {
    return NextResponse.json(
      {
        error: "PDFの取得に失敗しました",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }

  try {
    const bytes = Buffer.from(pdfBin);
    const pages = await extractPdfTextByPage(bytes);
    const raw = pages.slice(0, 10).join("\n");
    let summary = "";
    try {
      summary = await summarizeByLlm(raw);
    } catch {
      summary = summarizeExtractive(raw);
    }
    if (!summary) {
      return NextResponse.json(
        { error: "本文テキストを抽出できませんでした（画像PDFの可能性があります）" },
        { status: 422 },
      );
    }
    return NextResponse.json({ summary });
  } catch (e) {
    return NextResponse.json(
      {
        error: "要約の生成に失敗しました",
        details: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
