import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { embedQuery, openAiEmbeddingsEnabled } from "@/lib/embeddings";
import { isReferencesBibliographyChunk } from "@/lib/strip-references-section";

const CONTEXT_LIMIT = 10;
const MATCH_RPC_CAP = 28;
/** 設問文にそのまま含まれやすいよう短め。長すぎると言い換えでヒットしにくい。 */
const SIG_LEN = 36;
/** これ未満の断片は照合に使わない（ノイズ抑制） */
const MIN_SIG = 12;
/** 四分点付近も照合するチャンクの最小長 */
const QUARTER_SIG_MIN_CHUNK = 200;

export type QuizContextChunk = {
  content: string;
  /** document_chunks.pdf_page（未取り込みの旧データは null） */
  pdfPage: number | null;
};

type ChunkRow = { id: string; content: string; pdfPage: number | null };

export function normalizeChunkMatchKey(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function chunkSignatures(text: string): string[] {
  const t = normalizeChunkMatchKey(text);
  if (t.length === 0) return [];
  if (t.length <= SIG_LEN) return t.length >= MIN_SIG ? [t] : [];
  const sigs: string[] = [t.slice(0, SIG_LEN)];
  if (t.length >= QUARTER_SIG_MIN_CHUNK) {
    const q = Math.floor(t.length / 4);
    sigs.push(t.slice(q, q + SIG_LEN));
  }
  if (t.length > SIG_LEN * 2) {
    const mid = Math.floor(t.length / 2);
    sigs.push(t.slice(mid, mid + SIG_LEN));
  }
  const tailStart = Math.max(SIG_LEN, t.length - SIG_LEN);
  if (tailStart > SIG_LEN) sigs.push(t.slice(tailStart));
  return [...new Set(sigs)].filter((s) => s.length >= MIN_SIG);
}

/**
 * セッション群から「PDF 本文と照合する用」の文字列を生成（網羅率・出題バランスで共用）。
 * 出題時に保存した sourceExcerpt（教材からの原文コピー）を優先し、無い旧データのみ設問文＋模範解答を使う。
 */
export function buildPastQuestionHaystacksFromSessions(
  sessions: { questions_json: unknown }[],
): string[] {
  const out: string[] = [];
  for (const s of sessions) {
    const qj = s.questions_json;
    if (!Array.isArray(qj)) continue;
    for (const item of qj) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const src =
        typeof o.sourceExcerpt === "string"
          ? normalizeChunkMatchKey(o.sourceExcerpt)
          : "";
      if (src.length >= MIN_SIG) {
        out.push(src);
        continue;
      }
      const prompt = typeof o.prompt === "string" ? o.prompt : "";
      const ref =
        typeof o.referenceAnswer === "string" ? o.referenceAnswer : "";
      const hay = normalizeChunkMatchKey(`${prompt} ${ref}`);
      if (hay.length >= MIN_SIG) out.push(hay);
    }
  }
  return out;
}

export function countQuestionsInSessions(
  sessions: { questions_json: unknown }[],
): number {
  let n = 0;
  for (const s of sessions) {
    const qj = s.questions_json;
    if (!Array.isArray(qj)) continue;
    for (const item of qj) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.prompt === "string" && o.prompt.trim().length > 0) n += 1;
    }
  }
  return n;
}

export type ThesisChunkCoverageResult = {
  totalChunks: number;
  coveredChunks: number;
  totalQuestions: number;
  /** チャンクが 0 件のとき null */
  percent: number | null;
};

/**
 * 論文本文（チャンク分割＝PDF 全文の分割）に対し、出題時に記録した根拠抜粋（sourceExcerpt）が
 * 重なるチャンク割合を算出する。旧セッションは設問文ベースにフォールバックする。
 */
export function computeThesisChunkCoverage(params: {
  chunks: { content: string }[];
  sessions: { questions_json: unknown }[];
}): ThesisChunkCoverageResult {
  const pastHays = buildPastQuestionHaystacksFromSessions(params.sessions);
  const totalQuestions = countQuestionsInSessions(params.sessions);
  const usable = params.chunks.filter((c) => c.content.trim().length > 0);
  const totalChunks = usable.length;
  if (totalChunks === 0) {
    return { totalChunks: 0, coveredChunks: 0, totalQuestions, percent: null };
  }
  let covered = 0;
  for (const c of usable) {
    if (overlapHitCount(c.content, pastHays) > 0) covered += 1;
  }
  return {
    totalChunks,
    coveredChunks: covered,
    totalQuestions,
    percent: Math.round((100 * covered) / totalChunks),
  };
}

/** 過去設問と本文が重なる設問数（大きいほど「そのチャンク周辺は既に出題済み」） */
export function overlapHitCount(chunkContent: string, pastHays: string[]): number {
  const sigs = chunkSignatures(chunkContent);
  if (sigs.length === 0) return 0;
  let hits = 0;
  for (const hay of pastHays) {
    if (!hay) continue;
    if (sigs.some((sig) => hay.includes(sig))) hits += 1;
  }
  return hits;
}

function shuffleStableTiebreak<T>(arr: T[], key: (t: T) => number): T[] {
  const decorated = arr.map((item, idx) => ({
    item,
    k: key(item),
    r: Math.random(),
    idx,
  }));
  decorated.sort((a, b) => {
    if (a.k !== b.k) return a.k - b.k;
    if (a.r !== b.r) return a.r - b.r;
    return a.idx - b.idx;
  });
  return decorated.map((d) => d.item);
}

/**
 * テスト開始用: 教材チャンクから抜粋テキストを選ぶ。
 * 同一ユーザー・同一テストの過去セッション設問と重なりが少ないチャンクを優先する。
 */
export async function pickContextChunkContentsForQuiz(params: {
  admin: SupabaseClient;
  testId: string;
  userId: string;
}): Promise<QuizContextChunk[]> {
  const { admin, testId, userId } = params;

  const [{ data: chunkRows, error: chErr }, { data: sessionRows }] =
    await Promise.all([
      // pdf_page は 015 マイグレーション後のみ存在。* で既存 DB でも列不足エラーにならないようにする。
      admin.from("document_chunks").select("*").eq("test_id", testId),
      admin
        .from("quiz_sessions")
        .select("questions_json")
        .eq("test_id", testId)
        .eq("user_id", userId),
    ]);

  if (chErr) {
    throw new Error(`教材チャンクの取得に失敗しました: ${chErr.message}`);
  }
  if (!chunkRows?.length) {
    throw new Error(
      "教材チャンクが 1 件もありません。このテストの PDF 取り込み（processing_status）を確認してください。",
    );
  }

  const chunks: ChunkRow[] = chunkRows
    .map((r) => {
      const o = r as { content?: string; pdf_page?: number | null };
      const pp = o.pdf_page;
      const pdfPage =
        typeof pp === "number" && Number.isFinite(pp) && pp >= 1
          ? Math.floor(pp)
          : null;
      return {
        id: String((r as { id?: string }).id ?? ""),
        content: String(o.content ?? ""),
        pdfPage,
      };
    })
    .filter((c) => c.content.trim().length > 0)
    .filter((c) => !isReferencesBibliographyChunk(c.content));

  if (chunks.length === 0) {
    throw new Error(
      "出題に使える本文チャンクがありません（参考文献ブロックのみの可能性があります）。PDF を再取り込みするか、本文をご確認ください。",
    );
  }

  const pastHays = buildPastQuestionHaystacksFromSessions(sessionRows ?? []);
  const hitCount = (c: ChunkRow) => overlapHitCount(c.content, pastHays);
  const byFreshness = shuffleStableTiebreak(chunks, hitCount);

  const fillToLimit = (
    initial: QuizContextChunk[],
    seenKeys: Set<string>,
  ): QuizContextChunk[] => {
    const out = [...initial];
    for (const c of byFreshness) {
      const k = normalizeChunkMatchKey(c.content);
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      out.push({ content: c.content, pdfPage: c.pdfPage });
      if (out.length >= CONTEXT_LIMIT) break;
    }
    return out.slice(0, CONTEXT_LIMIT);
  };

  if (openAiEmbeddingsEnabled()) {
    const nonce = randomUUID();
    const query = `出題の多様化のための検索クエリ（因果・定義・計算・図表・論旨）: ${nonce}`;
    try {
      const qv = await embedQuery(query);
      const { data, error } = await admin.rpc("match_document_chunks", {
        p_test_id: testId,
        p_query_embedding: qv,
        p_match_count: MATCH_RPC_CAP,
      });

      if (!error && Array.isArray(data) && data.length > 0) {
        type RpcRow = { content?: string; similarity?: number };
        const rows = data as RpcRow[];
        const keyToChunk = new Map<string, ChunkRow>();
        for (const c of chunks) {
          keyToChunk.set(normalizeChunkMatchKey(c.content), c);
        }

        const enriched = rows
          .map((r) => {
            const content = String(r.content ?? "");
            if (!content.trim()) return null;
            const k = normalizeChunkMatchKey(content);
            const chunk = keyToChunk.get(k);
            const hits = chunk ? hitCount(chunk) : overlapHitCount(content, pastHays);
            const similarity =
              typeof r.similarity === "number" && !Number.isNaN(r.similarity)
                ? r.similarity
                : 0;
            return { content, hits, similarity };
          })
          .filter((x): x is NonNullable<typeof x> => x != null);

        enriched.sort((a, b) => {
          if (a.hits !== b.hits) return a.hits - b.hits;
          return b.similarity - a.similarity;
        });

        const seen = new Set<string>();
        const fromRpc: QuizContextChunk[] = [];
        for (const e of enriched) {
          const k = normalizeChunkMatchKey(e.content);
          if (seen.has(k)) continue;
          seen.add(k);
          const chunk = keyToChunk.get(k);
          fromRpc.push({
            content: e.content,
            pdfPage: chunk?.pdfPage ?? null,
          });
          if (fromRpc.length >= CONTEXT_LIMIT) break;
        }

        if (fromRpc.length > 0) {
          return fillToLimit(fromRpc, seen);
        }
      }
    } catch {
      // fall through to freshness-only
    }
  }

  return byFreshness.slice(0, CONTEXT_LIMIT).map((c) => ({
    content: c.content,
    pdfPage: c.pdfPage,
  }));
}
