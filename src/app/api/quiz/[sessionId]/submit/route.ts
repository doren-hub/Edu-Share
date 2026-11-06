import { randomUUID } from "node:crypto";
import { readBoundedJson, API_BODY_LIMITS } from "@/lib/request-json";
import { NextResponse } from "next/server";
import { llmRateLimitResponse } from "@/lib/llm-rate-limit";
import { quizSubmitSchema as bodySchema } from "@/lib/api-input-schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gradeWithClaude } from "@/lib/claude-quiz";
import { buildQuestionPerformanceAttempts } from "@/lib/question-performance";
import type { AnswerMap, StoredQuestion } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  const limited = await llmRateLimitResponse("quizSubmit", user.id);
  if (limited) return limited;

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("quiz_sessions")
    .select("id, user_id, test_id, questions_json, answers_json")
    .eq("id", sessionId)
    .single();

  if (error || !row) {
    return NextResponse.json({ error: "セッションが見つかりません" }, { status: 404 });
  }
  if (row.user_id !== user.id) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 });
  }

  const body = await readBoundedJson(req, API_BODY_LIMITS.quizSubmit);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
  }

  const questions = row.questions_json as StoredQuestion[];
  const answers = parsed.data.answers as AnswerMap;
  // 提出済みセッションは再採点しない（結果の上書き・統計の二重計上を防ぐ）。
  if (row.answers_json != null) {
    return NextResponse.json({ error: "このクイズは提出済みです" }, { status: 409 });
  }

  const token = randomUUID();
  const { data: claimed, error: claimError } = await admin.rpc("claim_quiz_grading", {
    p_session_id: sessionId, p_user_id: user.id, p_token: token,
  });
  if (claimError) {
    return NextResponse.json({ error: "採点の開始に失敗しました" }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ error: "このクイズは採点中または提出済みです" }, { status: 409 });
  }

  // 3分のDB leaseより短い2分で採点を打ち切る。中断した旧処理の保存はtokenで拒否する。
  const signal = AbortSignal.timeout(120_000);
  try {
    const graded = await gradeWithClaude({ questions, answers, signal, failOnError: true });
    signal.throwIfAborted();

    // 結果と統計を同一トランザクションで確定する。RPC が失敗すれば未提出のまま再試行できる。
    const { data: updated, error: upErr } = await admin.rpc("submit_quiz_with_performance", {
      p_session_id: sessionId,
      p_grading_token: token,
      p_user_id: user.id,
      p_answers: answers,
      p_score_mc: graded.scoreMc,
      p_score_essay: graded.scoreEssay,
      p_score_total: graded.scoreTotal,
      p_feedback: graded.feedback,
      p_attempts: row.test_id ? buildQuestionPerformanceAttempts({
        testId: row.test_id, questions, answers, feedback: graded.feedback,
      }) : [],
    });

    if (upErr) {
      return NextResponse.json(
        { error: upErr.message || "採点結果の保存に失敗しました" },
        { status: 500 },
      );
    }

    if (!updated) {
      return NextResponse.json({ error: "採点の処理権が失効しました。再試行してください" }, { status: 409 });
    }

    return NextResponse.json({
      scoreTotal: graded.scoreTotal,
      scoreMc: graded.scoreMc,
      scoreEssay: graded.scoreEssay,
      feedback: graded.feedback,
    });
  } catch {
    return NextResponse.json({ error: "採点に失敗しました。再試行してください" }, { status: 500 });
  } finally {
    // 保存成功後や、期限切れ後の新所有者には影響しない。解放失敗時もleaseで回復できる。
    try {
      await admin.rpc("release_quiz_grading", {
        p_session_id: sessionId, p_user_id: user.id, p_token: token,
      });
    } catch { /* 通信障害・プロセス中断時は期限切れで回復する。 */ }
  }
}
