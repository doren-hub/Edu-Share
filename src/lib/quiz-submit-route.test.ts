import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import ts from "typescript";
import * as schemas from "./api-input-schemas.ts";
import * as requestJson from "./request-json.ts";
import * as rateLimit from "./llm-rate-limit-test-store.ts";

beforeEach(() => rateLimit.resetLlmRateLimitForTests());

const require = createRequire(import.meta.url);
const { NextResponse } = require("next/server.js");
const sessionId = "22222222-2222-4222-8222-222222222222";
const userId = "quiz-user";

function loadWithStubs(path: string, stubs: Record<string, unknown>, signalApi = AbortSignal) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: Record<string, unknown> = {};
  const stubRequire = (name: string) => {
    assert.ok(Object.hasOwn(stubs, name), `Unexpected dependency: ${name}`);
    return stubs[name];
  };
  new Function("exports", "require", "AbortSignal", outputText)(exports, stubRequire, signalApi);
  return exports;
}

type Row = { id: string; user_id: string; test_id: string | null; questions_json: unknown; answers_json: unknown; score_mc: number; score_essay: number; score_total: number; feedback_json: unknown };

// RPC の成功・競合・エラーを模擬する。DB 内の原子性は隔離 PostgreSQL で別途検証。
function fixture(opts: { row?: Partial<Row>; user?: string | null; failSave?: boolean; failClaim?: boolean; failGrade?: boolean; failRelease?: boolean; expireDuringGrade?: boolean; timeout?: boolean } = {}) {
  const row: Row = {
    id: sessionId, user_id: userId, test_id: "test-1",
    questions_json: [{ id: "q1", type: "multiple_choice", prompt: "p", options: ["a", "b"], correctIndex: 0 }],
    answers_json: null, score_mc: 0, score_essay: 0, score_total: 0, feedback_json: null, ...opts.row,
  };
  const calls = { grade: 0, stats: 0, updates: 0 };
  let claim: string | null = null;
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(args.p_user_id, userId);
      assert.equal(args.p_session_id, sessionId);
      if (name === "claim_quiz_grading") {
        if (opts.failClaim) return { data: null, error: { message: "claim failed" } };
        if (claim || row.answers_json !== null) return { data: false, error: null };
        claim = args.p_token as string;
        return { data: true, error: null };
      }
      if (name === "release_quiz_grading") {
        if (opts.failRelease) throw new Error("release failed");
        if (claim === args.p_token) claim = null;
        return { data: true, error: null };
      }
      assert.equal(name, "submit_quiz_with_performance");
      if (claim !== args.p_grading_token) return { data: false, error: null };
      if (opts.failSave) return { data: null, error: { message: "injected failure" } };
      if (row.answers_json !== null) return { data: false, error: null };
      calls.updates++;
      calls.stats++;
      Object.assign(row, {
        answers_json: args.p_answers, score_mc: args.p_score_mc,
        score_essay: args.p_score_essay, score_total: args.p_score_total, feedback_json: args.p_feedback,
      });
      return { data: true, error: null };
    },
    from: (table: string) => {
      assert.equal(table, "quiz_sessions");
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { ...row }, error: null }) }) }),
      };
    },
  };
  let releaseGrade: (() => void) | null = null;
  let gradeStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { gradeStarted = resolve; });
  const route = loadWithStubs("../app/api/quiz/[sessionId]/submit/route.ts", {
    "node:crypto": { randomUUID },
    "next/server": { NextResponse },
    "@/lib/request-json": requestJson,
    "@/lib/llm-rate-limit": rateLimit,
    "@/lib/api-input-schemas": schemas,
    "@/lib/supabase/server": {
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: opts.user === null ? null : { id: opts.user ?? userId } } }) },
      }),
    },
    "@/lib/supabase/admin": { createAdminClient: () => admin },
    "@/lib/claude-quiz": {
      gradeWithClaude: async () => {
        calls.grade++;
        gradeStarted();
        if (releaseGrade === null) await new Promise<void>((r) => { releaseGrade = r; });
        if (opts.failGrade) throw new Error("grading failed");
        if (opts.expireDuringGrade) claim = "new-owner-token";
        return { scoreMc: 1, scoreEssay: 0, scoreTotal: 1, feedback: {} };
      },
    },
    "@/lib/question-performance": {
      buildQuestionPerformanceAttempts: () => [{ question_key: "key", correct: true }],
    },
  }, opts.timeout ? { timeout: () => AbortSignal.abort(new Error("deadline")) } as unknown as typeof AbortSignal : AbortSignal);
  const post = route.POST as (req: Request, ctx: { params: Promise<{ sessionId: string }> }) => Promise<Response>;
  const submit = (answer = 0) => post(
    new Request("https://unused.invalid/submit", { method: "POST", body: JSON.stringify({ answers: { q1: answer } }) }),
    { params: Promise.resolve({ sessionId }) },
  );
  return { row, calls, submit, started, getClaim: () => claim, release: () => releaseGrade?.(), opts, setSingleGrade: () => { releaseGrade = () => {}; } };
}

test("submit: 初回提出は採点を保存し統計を 1 回記録する", async () => {
  const f = fixture();
  f.setSingleGrade();
  const res = await f.submit();
  assert.equal(res.status, 200);
  assert.deepEqual(f.row.answers_json, { q1: 0 });
  assert.deepEqual(f.calls, { grade: 1, stats: 1, updates: 1 });
});

test("submit: 提出済みセッションへの再提出は 409 で拒否し結果を変えない", async () => {
  const f = fixture({ row: { answers_json: { q1: 1 }, score_mc: 0, score_total: 0, feedback_json: { result: "original" } } });
  const before = structuredClone(f.row);
  const res = await f.submit();
  assert.equal(res.status, 409);
  assert.deepEqual(f.row, before);
  assert.deepEqual(f.calls, { grade: 0, stats: 0, updates: 0 });
});

test("submit: 並行 2 提出では 1 件だけ保存され統計は 1 回分だけ増える", async () => {
  const f = fixture();
  const first = f.submit(0);
  await f.started;
  const second = await f.submit(1);
  assert.equal(second.status, 409);
  assert.equal(f.calls.grade, 1);
  f.release();
  const responses = [await first, second];
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const winningAnswer = responses[0].status === 200 ? 0 : 1;
  assert.deepEqual(f.row.answers_json, { q1: winningAnswer });
  const saved = structuredClone(f.row);
  assert.equal((await f.submit(1 - winningAnswer)).status, 409);
  assert.deepEqual(f.row, saved);
  assert.equal(f.calls.grade, 1);
  assert.equal(f.calls.updates, 1);
  assert.equal(f.calls.stats, 1);
});

test("submit: 未ログインは 401、他人のセッションは 403 で書き込まない", async () => {
  const anon = fixture({ user: null });
  assert.equal((await anon.submit()).status, 401);
  const other = fixture({ user: "someone-else" });
  assert.equal((await other.submit()).status, 403);
  for (const f of [anon, other]) assert.deepEqual(f.calls, { grade: 0, stats: 0, updates: 0 });
});

test("submit: RPC失敗では500を返し結果を確定しない", async () => {
  const f = fixture({ failSave: true });
  f.setSingleGrade();
  assert.equal((await f.submit()).status, 500);
  assert.equal(f.row.answers_json, null);
  assert.deepEqual(f.calls, { grade: 1, stats: 0, updates: 0 });
});


test("submit: 採点失敗と保存失敗はいずれも処理権を解放して再試行できる", async () => {
  for (const failure of ["failGrade", "failSave"] as const) {
    const f = fixture({ [failure]: true });
    f.setSingleGrade();
    assert.equal((await f.submit()).status, 500);
    assert.equal(f.getClaim(), null);
    assert.equal(f.row.answers_json, null);
    f.opts[failure] = false;
    assert.equal((await f.submit()).status, 200);
    assert.equal(f.calls.updates, 1);
    assert.equal(f.calls.stats, 1);
  }
});

test("submit: 処理権取得エラーではLLMを呼ばない", async () => {
  const f = fixture({ failClaim: true });
  assert.equal((await f.submit()).status, 500);
  assert.equal(f.calls.grade, 0);
});

test("submit: 失効した旧処理は新しい所有者の結果も処理権も変更しない", async () => {
  const f = fixture({ expireDuringGrade: true });
  f.setSingleGrade();
  assert.equal((await f.submit()).status, 409);
  assert.equal(f.getClaim(), "new-owner-token");
  assert.equal(f.row.answers_json, null);
  assert.equal(f.calls.updates, 0);
});

test("submit: 解放の通信失敗で元の失敗レスポンスを失わない", async () => {
  const f = fixture({ failGrade: true, failRelease: true });
  f.setSingleGrade();
  assert.equal((await f.submit()).status, 500);
  assert.notEqual(f.getClaim(), null); // DB lease expiry is tested in PostgreSQL.
});


test("submit: 採点の時間切れ後は保存せず処理権を解放する", async () => {
  const f = fixture({ timeout: true });
  f.setSingleGrade();
  assert.equal((await f.submit()).status, 500);
  assert.equal(f.row.answers_json, null);
  assert.equal(f.calls.updates, 0);
  assert.equal(f.getClaim(), null);
});
