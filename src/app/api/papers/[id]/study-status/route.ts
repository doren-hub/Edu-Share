import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  humanizePaperStudyStatusDbError,
  parsePaperStudyStatus,
  type StoredPaperStudyStatus,
} from "@/lib/paper-study-status";

export const runtime = "nodejs";

const bodySchema = z.object({
  status: z.string(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "id が不正です" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  const status = parsePaperStudyStatus(parsed.success ? parsed.data.status : null);
  if (!status) {
    return NextResponse.json({ error: "学習ステータスの指定が不正です" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, document_type")
    .eq("id", id)
    .maybeSingle();

  if (testError) {
    return NextResponse.json({ error: "論文を確認できませんでした" }, { status: 500 });
  }
  if (!test) {
    return NextResponse.json({ error: "論文が見つかりません" }, { status: 404 });
  }
  if (test.document_type !== "paper") {
    return NextResponse.json(
      { error: "過去問には学習ステータスを付けられません" },
      { status: 400 },
    );
  }

  if (status === "unconfirmed") {
    const { error } = await supabase
      .from("paper_study_statuses")
      .delete()
      .eq("user_id", auth.user.id)
      .eq("test_id", id);
    if (error) {
      return NextResponse.json(
        {
          error:
            humanizePaperStudyStatusDbError(error.message) ||
            "学習ステータスを保存できませんでした",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ status: "unconfirmed" });
  }

  const stored: StoredPaperStudyStatus = status;
  const { error } = await supabase.from("paper_study_statuses").upsert(
    { user_id: auth.user.id, test_id: id, status: stored },
    { onConflict: "user_id,test_id" },
  );
  if (error) {
    return NextResponse.json(
      {
        error:
          humanizePaperStudyStatusDbError(error.message) ||
          "学習ステータスを保存できませんでした",
      },
      { status: 500 },
    );
  }
  return NextResponse.json({ status: stored });
}
