import { NextResponse } from "next/server";
import { llmRateLimitResponse } from "@/lib/llm-rate-limit";
import { createClient } from "@/lib/supabase/server";
import { extractPdfTextByPage } from "@/lib/pdf-text-by-page";
import { summarizeByLlm } from "@/lib/pdf-summary.ts";

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

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  const limited = await llmRateLimitResponse("summarize", user.id);
  if (limited) return limited;

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

