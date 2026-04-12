import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gradeWithClaude } from "@/lib/claude-quiz";
import type { AnswerMap, StoredQuestion } from "@/lib/types";

export const runtime = "nodejs";

const bodySchema = z.object({
  answers: z.record(z.union([z.number(), z.string()])),
});

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

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("quiz_sessions")
    .select("id, user_id, questions_json")
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

  const graded = await gradeWithClaude({ questions, answers });

  const { error: upErr } = await admin
    .from("quiz_sessions")
    .update({
      answers_json: answers,
      score_mc: graded.scoreMc,
      score_essay: graded.scoreEssay,
      score_total: graded.scoreTotal,
      feedback_json: graded.feedback,
    })
    .eq("id", sessionId);

  if (upErr) {
    return NextResponse.json(
      { error: upErr.message || "採点結果の保存に失敗しました" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    scoreTotal: graded.scoreTotal,
    scoreMc: graded.scoreMc,
    scoreEssay: graded.scoreEssay,
    feedback: graded.feedback,
  });
}
