import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function loadWithStubs(path: string, stubs: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: Record<string, unknown> = {};
  const stubRequire = (name: string) => {
    assert.ok(Object.hasOwn(stubs, name), `Unexpected dependency: ${name}`);
    return stubs[name];
  };
  new Function("exports", "require", outputText)(exports, stubRequire);
  return exports;
}

type Row = { id: string; user_id: string; test_id: string | null; questions_json: unknown; answers_json: unknown; score_mc: number; score_essay: number; score_total: number; feedback_json: unknown };

// RPC の成功・競合・エラーを模擬する。DB 内の原子性は隔離 PostgreSQL で別途検証。
function fixture(opts: { row?: Partial<Row>; user?: string | null; failSave?: boolean } = {}) {
  const row: Row = {
    id: sessionId, user_id: userId, test_id: "test-1",
    questions_json: [{ id: "q1", type: "multiple_choice", prompt: "p", options: ["a", "b"], correctIndex: 0 }],
    answers_json: null, score_mc: 0, score_essay: 0, score_total: 0, feedback_json: null, ...opts.row,
  };
  const calls = { grade: 0, stats: 0, updates: 0 };
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, "submit_quiz_with_performance");
      assert.equal(args.p_user_id, userId);
      assert.equal(args.p_session_id, sessionId);
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
  const route = loadWithStubs("../app/api/quiz/[sessionId]/submit/route.ts", {
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
        // 並行提出を再現するため、2 件とも未提出を読んだ後に採点を終える。
        if (releaseGrade === null) await new Promise<void>((r) => { releaseGrade = r; });
        else releaseGrade();
        return { scoreMc: 1, scoreEssay: 0, scoreTotal: 1, feedback: {} };
      },
    },
    "@/lib/question-performance": {
      buildQuestionPerformanceAttempts: () => [{ question_key: "key", correct: true }],
    },
  });
  const post = route.POST as (req: Request, ctx: { params: Promise<{ sessionId: string }> }) => Promise<Response>;
  const submit = (answer = 0) => post(
    new Request("https://unused.invalid/submit", { method: "POST", body: JSON.stringify({ answers: { q1: answer } }) }),
    { params: Promise.resolve({ sessionId }) },
  );
  return { row, calls, submit, setSingleGrade: () => { releaseGrade = () => {}; } };
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
  const responses = await Promise.all([f.submit(0), f.submit(1)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const winningAnswer = responses[0].status === 200 ? 0 : 1;
  assert.deepEqual(f.row.answers_json, { q1: winningAnswer });
  const saved = structuredClone(f.row);
  assert.equal((await f.submit(1 - winningAnswer)).status, 409);
  assert.deepEqual(f.row, saved);
  assert.equal(f.calls.grade, 2);
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
