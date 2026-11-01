import { readBoundedJson, API_BODY_LIMITS } from "@/lib/request-json";
import { NextResponse } from "next/server";
import { quizSubmitSchema as bodySchema } from "@/lib/api-input-schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gradeWithClaude } from "@/lib/claude-quiz";
import { recordQuestionPerformanceAfterSubmit } from "@/lib/question-performance";
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

  const body = await readBoundedJson(req, API_BODY_LIMITS.quizSubmit);
  if (!body.ok) return body.response;
  const parsed = bodySchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
  }

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

  const questions = row.questions_json as StoredQuestion[];
  const answers = parsed.data.answers as AnswerMap;
  // 提出済みセッションは再採点しない（結果の上書き・統計の二重計上を防ぐ）。
  if (row.answers_json != null) {
    return NextResponse.json({ error: "このクイズは提出済みです" }, { status: 409 });
  }

  const graded = await gradeWithClaude({ questions, answers });

  const { data: updated, error: upErr } = await admin
    .from("quiz_sessions")
    .update({
      answers_json: answers,
      score_mc: graded.scoreMc,
      score_essay: graded.scoreEssay,
      score_total: graded.scoreTotal,
      feedback_json: graded.feedback,
    })
    .eq("id", sessionId)
    // 未提出 → 提出済みの遷移を条件付き更新で原子的に行う。並行提出では
    // 更新できた 1 リクエストだけが結果を保存し、統計を記録する。
    .is("answers_json", null)
    .select("id");

  if (upErr) {
    return NextResponse.json(
      { error: upErr.message || "採点結果の保存に失敗しました" },
      { status: 500 },
    );
  }

  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "このクイズは提出済みです" }, { status: 409 });
  }

  if (row.test_id) {
    await recordQuestionPerformanceAfterSubmit({
      admin,
      testId: row.test_id,
      userId: user.id,
      questions,
      answers,
      feedback: graded.feedback,
    });
  }

  return NextResponse.json({
    scoreTotal: graded.scoreTotal,
    scoreMc: graded.scoreMc,
    scoreEssay: graded.scoreEssay,
    feedback: graded.feedback,
  });
}
