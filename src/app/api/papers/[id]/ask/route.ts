import { readBoundedJson, API_BODY_LIMITS } from "@/lib/request-json";
import { NextResponse } from "next/server";
import { paperAskSchema as bodySchema, uuidSchema } from "@/lib/api-input-schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkUserAskRateLimit } from "@/lib/paper-ask-rate-limit";
import {
  askPaperQuestion,
  type PaperAskChunk,
  type PaperAskMessage,
} from "@/lib/paper-ask";
import { embedQuery, openAiEmbeddingsEnabled } from "@/lib/embeddings";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "id が不正です" }, { status: 400 });
  }

  const body = await readBoundedJson(req, API_BODY_LIMITS.paperAsk);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "入力が不正です";
    return NextResponse.json({ error: issue }, { status: 400 });
  }

  const { question, history } = parsed.data;

  // 1. ユーザー認証（ログイン必須）
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  // 2. ユーザーごとのレート制限（1分間に数回）
  const rate = checkUserAskRateLimit(auth.user.id);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "質問の回数制限に達しました。少し待ってから再度お試しください。",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      { status: 429 },
    );
  }

  // 3. 論文の存在と種別チェック
  const admin = createAdminClient();
  const { data: test, error: testError } = await admin
    .from("tests")
    .select("id, document_type, processing_status")
    .eq("id", id)
    .maybeSingle();

  if (testError || !test) {
    return NextResponse.json(
      { error: "対象の論文が見つかりません" },
      { status: 404 },
    );
  }
  if (test.document_type !== "paper") {
    return NextResponse.json(
      { error: "質問できるのは論文のみです" },
      { status: 400 },
    );
  }
  if (test.processing_status !== "ready") {
    return NextResponse.json(
      { error: "この論文はまだ取り込みが完了していません" },
      { status: 400 },
    );
  }

  // 4. 論文の document_chunks を全件取得（ベクトルは除外して取得量を最小化）
  const { data: chunkRows, error: chunkErr } = await admin
    .from("document_chunks")
    .select("id, chunk_index, content, pdf_page")
    .eq("test_id", id)
    .order("chunk_index", { ascending: true });

  if (chunkErr) {
    return NextResponse.json(
      { error: "論文チャンクの取得に失敗しました", details: chunkErr.message },
      { status: 500 },
    );
  }
  if (!chunkRows || chunkRows.length === 0) {
    return NextResponse.json(
      { error: "この論文には本文チャンクがありません" },
      { status: 400 },
    );
  }

  const allChunks: PaperAskChunk[] = chunkRows.map((r) => {
    const pp = r.pdf_page;
    const pdf_page =
      typeof pp === "number" && Number.isFinite(pp) && pp >= 1
        ? Math.floor(pp)
        : null;
    return {
      id: String(r.id),
      chunk_index: Number(r.chunk_index ?? 0),
      content: String(r.content ?? ""),
      pdf_page,
    };
  });

  const maxChars = Number(process.env.PAPER_ASK_MAX_CHARS) || 200_000;
  const totalChars = allChunks.reduce((acc, c) => acc + c.content.length, 0);

  let hasEmbeddings = false;
  let matchedChunks: PaperAskChunk[] | null = null;

  // 上限を超える場合のみ、埋め込みの有無を確認して類似度検索を試みる
  if (totalChars > maxChars && openAiEmbeddingsEnabled()) {
    const { data: sampleWithEmbedding } = await admin
      .from("document_chunks")
      .select("id")
      .eq("test_id", id)
      .not("embedding", "is", null)
      .limit(1);

    hasEmbeddings = Boolean(
      sampleWithEmbedding && sampleWithEmbedding.length > 0,
    );

    if (hasEmbeddings) {
      try {
        const qv = await embedQuery(question);
        const { data: rpcRows, error: rpcErr } = await admin.rpc(
          "match_document_chunks",
          {
            p_test_id: id,
            p_query_embedding: qv,
            p_match_count: 32,
          },
        );

        if (!rpcErr && Array.isArray(rpcRows) && rpcRows.length > 0) {
          // content で照合して元の chunk を紐付け
          const chunkByContent = new Map<string, PaperAskChunk>();
          for (const c of allChunks) {
            chunkByContent.set(c.content.trim(), c);
          }
          matchedChunks = (
            rpcRows as { content?: string; similarity?: number }[]
          )
            .map((row): PaperAskChunk | null => {
              const rawContent = String(row.content ?? "").trim();
              const original = chunkByContent.get(rawContent);
              if (!original) return null;
              return {
                ...original,
                similarity:
                  typeof row.similarity === "number" ? row.similarity : 0,
              };
            })
            .filter((c): c is PaperAskChunk => c != null);
        }
      } catch (e) {
        console.warn("[papers/ask] match_document_chunks error:", e);
      }
    }
  }

  try {
    const result = await askPaperQuestion({
      allChunks,
      question,
      history: history as PaperAskMessage[] | undefined,
      matchedChunks,
      hasEmbeddings,
      maxChars,
    });

    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    // 429 無料枠上限判定
    if (
      /\b429\b/.test(msg) ||
      /RESOURCE_EXHAUSTED/i.test(msg) ||
      /Too Many Requests/i.test(msg) ||
      /無料枠上限/.test(msg)
    ) {
      return NextResponse.json(
        {
          error:
            "Gemini API の無料枠上限（429）に達しました。少し待ってからもう一度お試しください。",
          details: msg,
        },
        { status: 429 },
      );
    }

    // キー未設定判定
    if (
      msg.includes("GEMINI_API_KEY") ||
      msg.includes("API キーが未設定") ||
      msg.includes("Google AI Studio")
    ) {
      return NextResponse.json(
        {
          error:
            "GEMINI_API_KEY（または GOOGLE_API_KEY）が未設定かサンプルのままです。Google AI Studio でキーを発行し .env.local に設定し、開発サーバーを再起動してください。",
          details: msg,
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { error: "Gemini への質問に失敗しました", details: msg },
      { status: 500 },
    );
  }
}
