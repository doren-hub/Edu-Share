import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedQuery } from "@/lib/embeddings";
import {
  generateQuizFromContext,
  stripForClient,
} from "@/lib/claude-quiz";
import type { StoredQuestion } from "@/lib/types";

export const runtime = "nodejs";

async function pickContextChunks(params: {
  testId: string;
  documentType: "past_exam" | "paper";
}): Promise<string[]> {
  const admin = createAdminClient();
  const nonce = randomUUID();

  if (process.env.OPENAI_API_KEY) {
    const query = `出題の多様化のための検索クエリ（因果・定義・計算・図表・論旨）: ${nonce}`;
    try {
      const qv = await embedQuery(query);
      const { data, error } = await admin.rpc("match_document_chunks", {
        p_test_id: params.testId,
        p_query_embedding: qv,
        p_match_count: 10,
      });

      if (!error && Array.isArray(data) && data.length > 0) {
        return data
          .map((r: { content?: string }) => String(r.content ?? ""))
          .filter(Boolean);
      }
    } catch {
      // fall through
    }
  }

  const { data: rows, error } = await admin
    .from("document_chunks")
    .select("content")
    .eq("test_id", params.testId);

  if (error || !rows?.length) {
    throw new Error("教材チャンクが見つかりません");
  }

  const shuffled = [...rows].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 10).map((r) => String(r.content));
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: testId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: test, error: tErr } = await admin
    .from("tests")
    .select("id, processing_status, document_type")
    .eq("id", testId)
    .single();

  if (tErr || !test) {
    return NextResponse.json({ error: "テストが見つかりません" }, { status: 404 });
  }
  if (test.processing_status !== "ready") {
    return NextResponse.json(
      { error: "このテストはまだ準備中です" },
      { status: 409 },
    );
  }

  const documentType =
    test.document_type === "paper" ? "paper" : "past_exam";

  const chunks = await pickContextChunks({ testId, documentType });
  const questions: StoredQuestion[] = await generateQuizFromContext({
    contextChunks: chunks,
    documentType,
    nonce: randomUUID(),
  });

  const { data: session, error: sErr } = await admin
    .from("quiz_sessions")
    .insert({
      user_id: user.id,
      test_id: testId,
      questions_json: questions,
    })
    .select("id")
    .single();

  if (sErr || !session) {
    return NextResponse.json(
      { error: sErr?.message || "セッション作成に失敗しました" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    sessionId: session.id,
    questions: stripForClient(questions),
  });
}
