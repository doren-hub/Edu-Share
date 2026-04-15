import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPdfBodyTextUnavailableNotice } from "@/lib/document-chunks";
import { pickContextChunkContentsForQuiz } from "@/lib/quiz-chunk-coverage";
import {
  generateQuizFromContext,
  stripForClient,
} from "@/lib/claude-quiz";
import { attachSourcePdfHighlightsToQuestions } from "@/lib/attach-source-pdf-highlights";
import { makeQuestionPerformanceKey } from "@/lib/question-performance";
import type { StoredQuestion } from "@/lib/types";
import { isStoredQuestionLike } from "@/lib/is-stored-question";
import {
  getNotebookLmQuizPoolJson,
  getNotebookLmVocabPoolJson,
  vocabPoolJsonToMultipleChoice,
} from "@/lib/notebooklm-csv";
import { loadPaperVocabSharedAnswerPool } from "@/lib/paper-vocab-shared-pool";
import {
  buildCsvQuestionPerformanceKeySet,
  inferNotebookLmCsvPoolKindFromQuestions,
  inferQuizSessionMaterialMode,
} from "@/lib/quiz-session-mode";
import {
  questionKeysEligibleForReview,
  type ReviewablePerformanceRow,
} from "@/lib/review-mode";

const startBodySchema = z.object({
  reuseQuestionsFromSessionId: z.string().uuid().optional(),
  /** 過去セッションの設問プールから重み付き無作為抽出（新規 LLM 生成はしない） */
  pickRandomPastSession: z.boolean().optional(),
  /** 誤答した設問のみ過去プールから抽出（通常／CSV は reviewMistakesScope で切替） */
  pickReviewMistakesSession: z.boolean().optional(),
  reviewMistakesScope: z.enum(["standard", "csv"]).optional(),
  /** Prefer NotebookLM CSV question pool over PDF/RAG (same test may have both). */
  useNotebookLmCsvPool: z.boolean().optional(),
  /** クイズ CSV 列と単語帳 CSV 列のどちらから出題するか（useNotebookLmCsvPool より優先） */
  notebookLmCsvPool: z.enum(["quiz", "vocab"]).optional(),
});

export const runtime = "nodejs";

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
}

/** プール件数に応じて 3〜9 問。十分あるときは 6〜9 の範囲でランダム */
function pickQuestionCountFromPool(poolLen: number): number {
  if (poolLen < 3) return poolLen;
  const maxN = Math.min(9, poolLen);
  if (maxN < 6) return maxN;
  return 6 + Math.floor(Math.random() * (maxN - 5));
}

function assignFreshQuestionIds(qs: StoredQuestion[]): StoredQuestion[] {
  const run = randomUUID().replace(/-/g, "").slice(0, 12);
  return qs.map((q, i) => ({
    ...q,
    id: `mix-${run}-${i}`,
  }));
}

function buildQuestionsFromNotebookLmPool(
  notebooklmQuestionsJson: unknown,
  poolKind?: "quiz" | "vocab",
  paperVocabSharedBacks?: string[],
): StoredQuestion[] | null {
  if (poolKind === "vocab") {
    const mcPool = vocabPoolJsonToMultipleChoice(
      notebooklmQuestionsJson,
      paperVocabSharedBacks ?? [],
    );
    if (!mcPool || mcPool.length < 3) return null;
    shuffleInPlace(mcPool);
    const n = pickQuestionCountFromPool(mcPool.length);
    return assignFreshQuestionIds(mcPool.slice(0, n));
  }
  if (!Array.isArray(notebooklmQuestionsJson)) return null;
  let pool = notebooklmQuestionsJson.filter(isStoredQuestionLike);
  if (poolKind === "quiz") {
    pool = pool.filter((q) => q.type === "multiple_choice");
  }
  if (pool.length < 3) return null;
  shuffleInPlace(pool);
  const n = pickQuestionCountFromPool(pool.length);
  return assignFreshQuestionIds(pool.slice(0, n));
}

/** 通常出題の過去プール用: CSV 由来セッションは混ぜない */
function filterPastRowsForStandardModeOnly<T extends { questions_json: unknown }>(
  rows: T[] | null | undefined,
): T[] {
  return (rows ?? []).filter(
    (r) => inferQuizSessionMaterialMode(r.questions_json) === "standard",
  );
}

function filterPastRowsForCsvModeOnly<T extends { questions_json: unknown }>(
  rows: T[] | null | undefined,
): T[] {
  return (rows ?? []).filter(
    (r) => inferQuizSessionMaterialMode(r.questions_json) === "csv",
  );
}

function tryNotebookLmCsvPoolEither(
  test: {
    notebooklm_questions_json?: unknown;
    notebooklm_vocab_questions_json?: unknown;
  },
  paperVocabSharedBacks?: string[],
): { questions: StoredQuestion[]; pool: "quiz" | "vocab" } | null {
  const fromQuiz = buildQuestionsFromNotebookLmPool(
    getNotebookLmQuizPoolJson(test),
    "quiz",
  );
  if (fromQuiz) return { questions: fromQuiz, pool: "quiz" };
  const fromVocab = buildQuestionsFromNotebookLmPool(
    getNotebookLmVocabPoolJson(test),
    "vocab",
    paperVocabSharedBacks,
  );
  if (!fromVocab) return null;
  return { questions: fromVocab, pool: "vocab" };
}

/** 同一テスト・同一ユーザーの過去セッションから有効な設問だけ集める */
function collectQuestionsFromPastSessions(
  rows: { questions_json: unknown }[] | null | undefined,
): StoredQuestion[] {
  const pool: StoredQuestion[] = [];
  for (const row of rows ?? []) {
    const qj = row.questions_json;
    if (!Array.isArray(qj)) continue;
    for (const item of qj) {
      if (isStoredQuestionLike(item)) {
        pool.push(structuredClone(item));
      }
    }
  }
  return pool;
}

function promptDedupKey(q: StoredQuestion): string {
  return q.prompt.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * LLM で得た base に対し、プールから重複プロンプトを避けつつ件数を増やす。
 * targetN 未満でプールが尽きたらその時点で打ち切り。
 */
function supplementQuestionsFromPool(
  base: StoredQuestion[],
  pool: StoredQuestion[],
  targetN: number,
): StoredQuestion[] {
  if (base.length >= targetN) return base;
  const used = new Set(base.map(promptDedupKey));
  const run = randomUUID().replace(/-/g, "").slice(0, 10);
  let pad = 0;
  const extra: StoredQuestion[] = [];
  for (const q of pool) {
    if (base.length + extra.length >= targetN) break;
    const k = promptDedupKey(q);
    if (used.has(k)) continue;
    used.add(k);
    extra.push({
      ...q,
      id: `fill-${run}-${pad++}`,
    });
  }
  return [...base, ...extra];
}

/** base とプール合算で目標件数（3〜9、ただし base を下回らない）を決める */
function targetQuestionCount(baseLen: number, poolLen: number): number {
  const combined = baseLen + poolLen;
  const raw = pickQuestionCountFromPool(combined);
  return Math.min(9, Math.max(baseLen, raw));
}

type QuestionPerfRow = { question_key: string; attempts: number; correct_count: number };

/** 同一プロンプトは 1 件にまとめる（重複出題を減らす） */
function dedupeQuestionsByPrompt(pool: StoredQuestion[]): StoredQuestion[] {
  const seen = new Map<string, StoredQuestion>();
  for (const q of pool) {
    const k = promptDedupKey(q);
    if (!seen.has(k)) seen.set(k, q);
  }
  return [...seen.values()];
}

function correctRateFromPerf(row: QuestionPerfRow | undefined): number | null {
  if (!row || row.attempts <= 0) return null;
  return row.correct_count / row.attempts;
}

/** question_performance の正答率に応じた重み（未計測は中程度）。alpha で寄せの強さを調整。 */
function weightForPastQuestionPick(correctRate: number | null, alpha = 1.65): number {
  const miss = correctRate == null ? 0.38 : 1 - correctRate;
  return 1 + alpha * miss;
}

/** 重みに比例した無作為抽出（非復元）。 */
function weightedSampleWithoutReplacement<T>(
  items: T[],
  weightOf: (item: T) => number,
  n: number,
): T[] {
  const bag = items.map((t) => ({ t, w: Math.max(weightOf(t), 1e-9) }));
  const out: T[] = [];
  const take = Math.min(n, bag.length);
  for (let k = 0; k < take; k++) {
    const total = bag.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let picked = false;
    for (let j = 0; j < bag.length; j++) {
      r -= bag[j]!.w;
      if (r <= 0) {
        out.push(bag[j]!.t);
        bag.splice(j, 1);
        picked = true;
        break;
      }
    }
    if (!picked && bag.length > 0) {
      out.push(bag[bag.length - 1]!.t);
      bag.pop();
    }
  }
  return out;
}

/** 「過去から出題」用: 重み付き無作為で n 問選ぶ */
function pickPastQuestionsWeightedByMissRate(params: {
  pool: StoredQuestion[];
  testId: string;
  perfByKey: Map<string, QuestionPerfRow>;
  n: number;
}): StoredQuestion[] {
  const { pool, testId, perfByKey, n } = params;
  const unique = dedupeQuestionsByPrompt(pool);
  const source = unique.length >= 3 ? unique : pool;
  return weightedSampleWithoutReplacement(source, (q) => {
    const key = makeQuestionPerformanceKey(testId, q);
    const rate = correctRateFromPerf(perfByKey.get(key));
    return weightForPastQuestionPick(rate);
  }, n);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: testId } = await ctx.params;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
    }

    const rawBody = await req.json().catch(() => ({}));
    const parsedBody = startBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return NextResponse.json({ error: "入力が不正です" }, { status: 400 });
    }
    const {
      reuseQuestionsFromSessionId: reuseSessionId,
      pickRandomPastSession,
      pickReviewMistakesSession: pickReviewMistakesSessionRaw,
      reviewMistakesScope: reviewMistakesScopeRaw,
      useNotebookLmCsvPool,
      notebookLmCsvPool: notebookLmCsvPoolRaw,
    } = parsedBody.data;
    const pickReviewMistakesSession = pickReviewMistakesSessionRaw === true;
    const reviewMistakesScope = reviewMistakesScopeRaw ?? "standard";
    const wantsExplicitNotebookLmCsv =
      notebookLmCsvPoolRaw != null || useNotebookLmCsvPool === true;
    const notebookLmCsvPool =
      notebookLmCsvPoolRaw ?? (useNotebookLmCsvPool ? "quiz" : undefined);
    if (reuseSessionId && pickRandomPastSession) {
      return NextResponse.json(
        { error: "reuseQuestionsFromSessionId と pickRandomPastSession は同時に使えません" },
        { status: 400 },
      );
    }
    if (reuseSessionId && pickReviewMistakesSession) {
      return NextResponse.json(
        { error: "再出題と復習モードは同時に使えません" },
        { status: 400 },
      );
    }
    if (pickRandomPastSession && pickReviewMistakesSession) {
      return NextResponse.json(
        { error: "過去から出題と復習モードは同時に使えません" },
        { status: 400 },
      );
    }
    if (
      pickReviewMistakesSession &&
      (notebookLmCsvPool != null || useNotebookLmCsvPool === true)
    ) {
      return NextResponse.json(
        { error: "復習モードと NotebookLM CSV プール指定は同時に使えません" },
        { status: 400 },
      );
    }
    if (notebookLmCsvPool && (reuseSessionId || pickRandomPastSession)) {
      return NextResponse.json(
        { error: "NotebookLM CSV プール指定は再出題・過去出題と同時に使えません" },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const { data: test, error: tErr } = await admin
      .from("tests")
      .select(
        "id, processing_status, document_type, processing_error, pdf_storage_path, quiz_source, notebooklm_questions_json, notebooklm_vocab_questions_json",
      )
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

    const paperVocabSharedBacks =
      test.document_type === "paper" && wantsExplicitNotebookLmCsv
        ? await loadPaperVocabSharedAnswerPool(admin)
        : [];

    let questions!: StoredQuestion[];
    let notebookLmCsvPoolStored: "quiz" | "vocab" | null = null;

    if (reuseSessionId) {
      const { data: src, error: srcErr } = await admin
        .from("quiz_sessions")
        .select("id, test_id, user_id, questions_json, notebook_lm_csv_pool")
        .eq("id", reuseSessionId)
        .single();

      if (srcErr || !src) {
        return NextResponse.json(
          { error: "参照元のセッションが見つかりません" },
          { status: 404 },
        );
      }
      if (src.test_id !== testId) {
        return NextResponse.json(
          { error: "別のテストのセッションです" },
          { status: 400 },
        );
      }
      if (src.user_id !== user.id) {
        return NextResponse.json({ error: "権限がありません" }, { status: 403 });
      }
      const qj = src.questions_json;
      if (!Array.isArray(qj) || qj.length < 1) {
        return NextResponse.json(
          { error: "参照元の問題データが無効です" },
          { status: 400 },
        );
      }
      questions = structuredClone(qj) as StoredQuestion[];
      const col = (src as { notebook_lm_csv_pool?: string | null }).notebook_lm_csv_pool;
      if (col === "quiz" || col === "vocab") {
        notebookLmCsvPoolStored = col;
      } else if (inferQuizSessionMaterialMode(questions) === "csv") {
        notebookLmCsvPoolStored =
          inferNotebookLmCsvPoolKindFromQuestions(questions) ?? null;
      } else {
        notebookLmCsvPoolStored = null;
      }
    } else if (pickRandomPastSession) {
      const { data: pastRows, error: pastErr } = await admin
        .from("quiz_sessions")
        .select("questions_json")
        .eq("test_id", testId)
        .eq("user_id", user.id);

      if (pastErr) {
        return NextResponse.json(
          { error: "過去セッションの取得に失敗しました", details: pastErr.message },
          { status: 500 },
        );
      }

      const pastRowsStandard = filterPastRowsForStandardModeOnly(pastRows);
      const pool = collectQuestionsFromPastSessions(pastRowsStandard);

      const { data: perfRows, error: perfErr } = await admin
        .from("question_performance")
        .select("question_key, attempts, correct_count")
        .eq("test_id", testId)
        .eq("user_id", user.id);
      if (perfErr) {
        console.warn("[tests/start] question_performance:", perfErr.message);
      }
      const perfByKey = new Map<string, QuestionPerfRow>();
      for (const r of perfRows ?? []) {
        if (r && typeof (r as QuestionPerfRow).question_key === "string") {
          const row = r as QuestionPerfRow;
          perfByKey.set(row.question_key, row);
        }
      }

      if (pastRowsStandard.length === 0) {
        return NextResponse.json(
          {
            error: "テスト履歴がありません",
            details:
              "PDF・通常出題の履歴がありません。「テスト開始」で一度受験するか、NotebookLM CSV から受験した履歴は CSV モードの「過去の問題から出題」をご利用ください。",
          },
          { status: 409 },
        );
      }
      if (pool.length < 3) {
        return NextResponse.json(
          {
            error: "出題できる問題が足りません",
            details:
              "PDF・通常出題の過去設問を合わせても 3 問に満ちません。通常モードで「テスト開始」をしてからお試しください。",
          },
          { status: 409 },
        );
      }

      const n = pickQuestionCountFromPool(pool.length);
      questions = assignFreshQuestionIds(
        pickPastQuestionsWeightedByMissRate({ pool, testId, perfByKey, n }),
      );
    } else if (pickReviewMistakesSession) {
      const scope = reviewMistakesScope === "csv" ? "csv" : "standard";

      const { data: pastRowsAll, error: pastErr } = await admin
        .from("quiz_sessions")
        .select("questions_json, answers_json")
        .eq("test_id", testId)
        .eq("user_id", user.id);

      if (pastErr) {
        return NextResponse.json(
          { error: "過去セッションの取得に失敗しました", details: pastErr.message },
          { status: 500 },
        );
      }

      const csvKeys = buildCsvQuestionPerformanceKeySet(testId, pastRowsAll ?? []);

      const { data: perfRows, error: perfErr } = await admin
        .from("question_performance")
        .select("question_key, attempts, correct_count, prompt_excerpt, question_type")
        .eq("test_id", testId)
        .eq("user_id", user.id);
      if (perfErr) {
        console.warn("[tests/start] question_performance (review):", perfErr.message);
      }
      const perfForReview: ReviewablePerformanceRow[] = [];
      for (const r of perfRows ?? []) {
        if (!r || typeof (r as ReviewablePerformanceRow).question_key !== "string") continue;
        const row = r as ReviewablePerformanceRow;
        if (typeof row.prompt_excerpt !== "string" || typeof row.question_type !== "string")
          continue;
        perfForReview.push(row);
      }
      const perfByKey = new Map<string, QuestionPerfRow>();
      for (const r of perfForReview) {
        perfByKey.set(r.question_key, {
          question_key: r.question_key,
          attempts: r.attempts,
          correct_count: r.correct_count,
        });
      }

      const eligibleKeys = questionKeysEligibleForReview(perfForReview);
      const missKeySet = new Set<string>();
      for (const key of eligibleKeys) {
        if (scope === "csv") {
          if (csvKeys.has(key)) missKeySet.add(key);
        } else if (!csvKeys.has(key)) {
          missKeySet.add(key);
        }
      }

      if (missKeySet.size === 0) {
        return NextResponse.json(
          {
            error: "復習する設問がありません",
            details:
              scope === "csv"
                ? "CSV モードで、正答率が 90% 以下の設問がまだありません（または履歴がありません）。"
                : "PDF・通常モードで、正答率が 90% 以下の設問がまだありません（または履歴がありません）。",
          },
          { status: 409 },
        );
      }

      const pastFiltered =
        scope === "csv"
          ? filterPastRowsForCsvModeOnly(pastRowsAll)
          : filterPastRowsForStandardModeOnly(pastRowsAll);

      if (pastFiltered.length === 0) {
        return NextResponse.json(
          {
            error: "テスト履歴がありません",
            details:
              scope === "csv"
                ? "NotebookLM CSV で受験した履歴がありません。"
                : "PDF・通常出題の履歴がありません。",
          },
          { status: 409 },
        );
      }

      let pool = collectQuestionsFromPastSessions(pastFiltered);
      pool = pool.filter((q) => missKeySet.has(makeQuestionPerformanceKey(testId, q)));

      if (pool.length < 3) {
        return NextResponse.json(
          {
            error: "復習できる問題が足りません",
            details:
              "誤答した設問を過去セッションから揃えても 3 問に満ちません。該当モードでもう一度受験してからお試しください。",
          },
          { status: 409 },
        );
      }

      const n = pickQuestionCountFromPool(pool.length);
      questions = assignFreshQuestionIds(
        pickPastQuestionsWeightedByMissRate({ pool, testId, perfByKey, n }),
      );

      if (inferQuizSessionMaterialMode(questions) === "csv") {
        notebookLmCsvPoolStored =
          inferNotebookLmCsvPoolKindFromQuestions(questions) ?? null;
      }
    } else {
      let decided = false;

      if (notebookLmCsvPool) {
        const raw =
          notebookLmCsvPool === "vocab"
            ? getNotebookLmVocabPoolJson(test)
            : getNotebookLmQuizPoolJson(test);
        const qs = buildQuestionsFromNotebookLmPool(
          raw,
          notebookLmCsvPool,
          notebookLmCsvPool === "vocab" ? paperVocabSharedBacks : undefined,
        );
        if (!qs) {
          return NextResponse.json(
            { error: "CSV 由来の問題数が不足しています（3問以上必要です）" },
            { status: 409 },
          );
        }
        questions = qs;
        decided = true;
        notebookLmCsvPoolStored = notebookLmCsvPool;
      } else if (wantsExplicitNotebookLmCsv && test.quiz_source === "notebooklm_csv") {
        const picked = tryNotebookLmCsvPoolEither(test, paperVocabSharedBacks);
        if (!picked) {
          return NextResponse.json(
            { error: "CSV 由来の問題数が不足しています（3問以上必要です）" },
            { status: 409 },
          );
        }
        questions = picked.questions;
        notebookLmCsvPoolStored = picked.pool;
        decided = true;
      }

      if (
        !decided &&
        wantsExplicitNotebookLmCsv &&
        isPdfBodyTextUnavailableNotice(test.processing_error)
      ) {
        const picked = tryNotebookLmCsvPoolEither(test, paperVocabSharedBacks);
        if (picked) {
          questions = picked.questions;
          notebookLmCsvPoolStored = picked.pool;
          decided = true;
        } else {
          return NextResponse.json(
            {
              error: "このPDFからは問題を自動生成できません",
              details:
                "本文テキストを読み取れていません。テキストがコピーできるPDFへ差し替えて取り込み直すか、テスト履歴から「再テスト」をご利用ください。",
            },
            { status: 409 },
          );
        }
      }

      if (!decided) {
        const { count, error: cntErr } = await admin
          .from("document_chunks")
          .select("id", { count: "exact", head: true })
          .eq("test_id", testId);
        if (cntErr) {
          return NextResponse.json(
            { error: "教材データの確認に失敗しました", details: cntErr.message },
            { status: 500 },
          );
        }
        if (!count || count < 1) {
          if (wantsExplicitNotebookLmCsv) {
            const picked = tryNotebookLmCsvPoolEither(test, paperVocabSharedBacks);
            if (picked) {
              questions = picked.questions;
              notebookLmCsvPoolStored = picked.pool;
              decided = true;
            } else {
              return NextResponse.json(
                {
                  error: "このPDFからは問題を自動生成できません",
                  details:
                    "本文テキストが検出されませんでした。テキスト選択できるPDFへ差し替えて取り込み直すか、テスト履歴から「再テスト」をご利用ください。",
                },
                { status: 409 },
              );
            }
          } else {
            return NextResponse.json(
              {
                error: "このPDFからは問題を自動生成できません",
                details:
                  "本文チャンクがありません。取り込みを確認するか、NotebookLM CSV での受験は CSV 用の開始ボタンから行ってください。",
              },
              { status: 409 },
            );
          }
        }
      }

      if (!decided) {
        const documentType =
          test.document_type === "paper" ? "paper" : "past_exam";

        const chunks = await pickContextChunkContentsForQuiz({
          admin,
          testId,
          userId: user.id,
        });
        questions = await generateQuizFromContext({
          contextChunks: chunks,
          documentType,
          nonce: randomUUID(),
        });

        const { data: pastRowsForPad } = await admin
          .from("quiz_sessions")
          .select("questions_json")
          .eq("test_id", testId)
          .eq("user_id", user.id);
        const pastPool = collectQuestionsFromPastSessions(
          filterPastRowsForStandardModeOnly(pastRowsForPad),
        );

        if (questions.length === 0) {
          if (pastPool.length < 3) {
            return NextResponse.json(
              {
                error: "有効な問題を生成できませんでした",
                details:
                  "過去に同一教材で保存された設問も 3問未満のため補填できません。もう一度テスト開始をお試しください。",
              },
              { status: 409 },
            );
          }
          shuffleInPlace(pastPool);
          const n = pickQuestionCountFromPool(pastPool.length);
          questions = assignFreshQuestionIds(pastPool.slice(0, n));
        } else {
          shuffleInPlace(pastPool);
          const targetN = targetQuestionCount(questions.length, pastPool.length);
          questions = supplementQuestionsFromPool(questions, pastPool, targetN);
          if (questions.length < 3) {
            return NextResponse.json(
              {
                error: "出題できる問題が足りません",
                details:
                  "自動生成と過去の設問を合わせても 3問に満ちません。時間をおいて再度お試しください。",
              },
              { status: 409 },
            );
          }
        }

        const pdfPath = test.pdf_storage_path?.trim();
        if (pdfPath) {
          const { data: pdfBlob, error: dlErr } = await admin.storage
            .from("pdfs")
            .download(pdfPath);
          if (!dlErr && pdfBlob) {
            try {
              const buf = Buffer.from(await pdfBlob.arrayBuffer());
              await attachSourcePdfHighlightsToQuestions(questions, buf);
            } catch (e) {
              console.warn("[tests/start] attachSourcePdfHighlightsToQuestions:", e);
            }
          }
        }
      }
    }

    const { data: session, error: sErr } = await admin
      .from("quiz_sessions")
      .insert({
        user_id: user.id,
        test_id: testId,
        questions_json: questions,
        notebook_lm_csv_pool: notebookLmCsvPoolStored,
      })
      .select("id")
      .single();

    if (sErr || !session) {
      return NextResponse.json(
        {
          error: "セッション作成に失敗しました",
          details: sErr?.message,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      sessionId: session.id,
      questions: stripForClient(questions),
    });
  } catch (e) {
    const details = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "テストの開始に失敗しました", details },
      { status: 500 },
    );
  }
}
