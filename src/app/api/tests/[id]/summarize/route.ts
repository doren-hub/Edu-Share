import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractPdfTextByPage } from "@/lib/pdf-text-by-page";
import { generateLlmText } from "@/lib/llm-text";

export const runtime = "nodejs";

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[。．.!?！？])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18);
}

function sanitizePdfText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

async function summarizeByLlm(raw: string): Promise<string> {
  const context = sanitizePdfText(raw).slice(0, 14000);
  if (!context) return "";
  const text = await generateLlmText({
    system:
      "あなたは論文・技術文書の要約アシスタントです。日本語で簡潔かつ正確に要約します。",
    user: `以下の資料本文（抽出テキスト）を読み、次の見出しで要約してください。
- 主な研究手法
- 主要な発見
- 推奨事項
- 結論

注意:
- 数値・固有名詞は本文にある場合のみ書く
- 不明な情報は推測しない
- 出力は日本語

本文:
${context}`,
    maxTokens: 1200,
    temperature: 0.2,
  });
  return text.trim();
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

  const { data: pdfBin, error: dlErr } = await admin.storage
    .from("pdfs")
    .download(row.pdf_storage_path);
  if (dlErr || !pdfBin) {
    return NextResponse.json(
      { error: "PDFの取得に失敗しました" },
      { status: 500 },
    );
  }

  try {
    const bytes = Buffer.from(await pdfBin.arrayBuffer());
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

