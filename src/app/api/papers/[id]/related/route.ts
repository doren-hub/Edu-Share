import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { paperAuthorNamesForDisplay } from "@/lib/paper-authors";
import { findCommonAuthors } from "@/lib/paper-related";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "id が不正です" }, { status: 400 });
  }

  // 1. ユーザー用クライアントで対象論文の存在と公開権限を確認（RLS 準拠）
  const supabase = await createClient();
  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id, title, document_type, processing_status, paper_authors, source_name")
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
      { error: "対象が論文ではありません" },
      { status: 400 },
    );
  }

  // 2. 対象論文のチャンク埋め込み存在チェック（admin クライアント）
  const admin = createAdminClient();
  const { count: chunkCount, error: countError } = await admin
    .from("document_chunks")
    .select("id", { count: "exact", head: true })
    .eq("test_id", id)
    .not("embedding", "is", null);

  const hasEmbedding = !countError && (chunkCount ?? 0) > 0;

  // 3. 内容が近い論文を k=5 件抽出（service_role RPC を実行後、閲覧権限のある論文に絞る）
  const similarPapers: Array<{ id: string; title: string; similarity: number }> = [];

  if (hasEmbedding) {
    try {
      const { data: rpcRows, error: rpcError } = await admin.rpc(
        "match_related_papers",
        { p_test_id: id, p_match_count: 5 },
      );

      if (!rpcError && Array.isArray(rpcRows) && rpcRows.length > 0) {
        const candidateIds = rpcRows.map((r: { id: string }) => r.id);
        const { data: readableTests } = await supabase
          .from("tests")
          .select("id, title")
          .in("id", candidateIds)
          .eq("document_type", "paper");

        const readableMap = new Map(
          (readableTests ?? []).map((t) => [t.id, t.title]),
        );

        for (const row of rpcRows as Array<{ id: string; similarity: number }>) {
          if (readableMap.has(row.id)) {
            similarPapers.push({
              id: row.id,
              title: readableMap.get(row.id)!,
              similarity: Math.round(Number(row.similarity) * 1000) / 1000,
            });
          }
        }
      }
    } catch (e) {
      console.warn("[papers/related] match_related_papers error:", e);
    }
  }

  // 4. 共著者による関連論文を抽出
  const targetAuthors = paperAuthorNamesForDisplay(
    test.paper_authors,
    test.source_name ?? "",
  );

  const coauthorPapers: Array<{
    id: string;
    title: string;
    commonAuthors: string[];
  }> = [];

  if (targetAuthors.length > 0) {
    const { data: candidateRows } = await supabase
      .from("tests")
      .select("id, title, paper_authors, source_name")
      .eq("document_type", "paper")
      .neq("id", id);

    if (Array.isArray(candidateRows)) {
      for (const cand of candidateRows) {
        const candAuthors = paperAuthorNamesForDisplay(
          cand.paper_authors,
          cand.source_name ?? "",
        );
        const common = findCommonAuthors(targetAuthors, candAuthors);
        if (common.length > 0) {
          coauthorPapers.push({
            id: cand.id,
            title: cand.title,
            commonAuthors: common,
          });
        }
      }

      coauthorPapers.sort((a, b) => {
        if (b.commonAuthors.length !== a.commonAuthors.length) {
          return b.commonAuthors.length - a.commonAuthors.length;
        }
        return a.title.localeCompare(b.title);
      });
    }
  }

  return NextResponse.json({
    target: {
      id: test.id,
      title: test.title,
      hasEmbedding,
    },
    similarPapers,
    coauthorPapers,
  });
}
