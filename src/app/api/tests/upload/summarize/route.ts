import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfTextByPage } from "@/lib/pdf-text-by-page";
import { generateLlmText } from "@/lib/llm-text";

export const runtime = "nodejs";

function looksLikePdf(file: File): boolean {
  if (file.type === "application/pdf") return true;
  const name = file.name?.toLowerCase() ?? "";
  return file.type === "" && name.endsWith(".pdf");
}

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

  // 先頭寄りの説明文を重視して 3 文まで採用
  const picked: string[] = [];
  for (const s of sentences) {
    if (picked.length >= 3) break;
    if (s.length > 220) {
      picked.push(`${s.slice(0, 217).trim()}...`);
    } else {
      picked.push(s);
    }
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
  if (!looksLikePdf(file)) {
    return NextResponse.json({ error: "PDFのみ対応しています" }, { status: 400 });
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
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

