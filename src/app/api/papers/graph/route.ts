import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizePaperIndustriesFromDb } from "@/lib/paper-industries";
import { paperAuthorNamesForDisplay } from "@/lib/paper-authors";
import {
  buildGlobalGraphData,
  matchesGraphFilter,
  type GlobalGraphPaperCandidate,
  type GlobalGraphResponse,
} from "@/lib/paper-related";

export const runtime = "nodejs";

const THRESHOLD = 200;

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (index < items.length) {
        const i = index++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const industryParam = url.searchParams.get("industry") || undefined;
  const yearParam = url.searchParams.get("year") || undefined;
  const kParam = parseInt(url.searchParams.get("k") ?? "5", 10);
  const k = Number.isFinite(kParam) ? Math.max(1, Math.min(20, kParam)) : 5;

  // 1. ユーザー用クライアントで全 ready 論文を取得（RLS 準拠）
  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("tests")
    .select(
      "id, title, industry, industries, publication_year, paper_authors, source_name",
    )
    .eq("document_type", "paper")
    .eq("processing_status", "ready")
    .order("created_at", { ascending: false });

  if (error || !rows) {
    return NextResponse.json(
      { error: "論文データの取得に失敗しました" },
      { status: 500 },
    );
  }

  // 2. 論文データの正規化
  const allPapers = rows.map((r) => ({
    id: r.id as string,
    title: (r.title as string) || "無題の論文",
    industries: normalizePaperIndustriesFromDb(r.industries, r.industry),
    publicationYear: r.publication_year ? String(r.publication_year).trim() : null,
    authors: paperAuthorNamesForDisplay(
      r.paper_authors,
      r.source_name ?? "",
    ),
  }));

  // 3. 絞り込み選択肢の算出（全 ready 論文を対象）
  const industrySet = new Set<string>();
  const yearSet = new Set<string>();

  for (const p of allPapers) {
    for (const ind of p.industries) {
      if (ind) industrySet.add(ind);
    }
    if (p.publicationYear) {
      yearSet.add(p.publicationYear);
    }
  }

  const availableIndustries = Array.from(industrySet).sort((a, b) =>
    a.localeCompare(b, "ja", { sensitivity: "base" }),
  );
  const availableYears = Array.from(yearSet).sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
    return b.localeCompare(a);
  });

  const totalCount = allPapers.length;

  // 4. 業界・発表年によるノード絞り込み
  const filtered = allPapers.filter((p) =>
    matchesGraphFilter(p, industryParam, yearParam),
  );
  const filteredCount = filtered.length;

  // 5. 200件を超えた場合は絞り込みを促す表示にする（辺の大量計算を抑止）
  if (filteredCount > THRESHOLD) {
    const response: GlobalGraphResponse = {
      totalCount,
      filteredCount,
      exceeded: true,
      threshold: THRESHOLD,
      availableIndustries,
      availableYears,
      nodes: [],
      links: [],
    };
    return NextResponse.json(response);
  }

  // 6. 200件以下の場合は内容類似度を計算（admin RPC）
  const filteredIdSet = new Set(filtered.map((p) => p.id));
  const admin = createAdminClient();

  const candidatesWithSim: GlobalGraphPaperCandidate[] = await mapConcurrent(
    filtered,
    8,
    async (p) => {
      let similarCandidates: Array<{ id: string; similarity: number }> = [];
      try {
        const { data: rpcRows, error: rpcError } = await admin.rpc(
          "match_related_papers",
          { p_test_id: p.id, p_match_count: 50 },
        );
        if (!rpcError && Array.isArray(rpcRows)) {
          similarCandidates = rpcRows
            .filter(
              (r: { id: string }) =>
                r.id !== p.id && filteredIdSet.has(r.id),
            )
            .map((r: { id: string; similarity: number }) => ({
              id: r.id,
              similarity: Math.round(Number(r.similarity) * 1000) / 1000,
            }));
        }
      } catch (err) {
        console.warn(`[papers/graph] match_related_papers failed for ${p.id}:`, err);
      }

      return {
        id: p.id,
        title: p.title,
        industries: p.industries,
        publicationYear: p.publicationYear,
        authors: p.authors,
        similarCandidates,
      };
    },
  );

  // 7. 全体グラフの構築（類似度 k 件打ち切り + 共著者判定 + カーブオフセット）
  const graph = buildGlobalGraphData(candidatesWithSim, k);

  const response: GlobalGraphResponse = {
    totalCount,
    filteredCount,
    exceeded: false,
    threshold: THRESHOLD,
    availableIndustries,
    availableYears,
    nodes: graph.nodes,
    links: graph.links,
  };

  return NextResponse.json(response);
}
