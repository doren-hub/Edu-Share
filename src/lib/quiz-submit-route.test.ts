import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import * as schemas from "./api-input-schemas.ts";
import * as requestJson from "./request-json.ts";

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

type Row = { id: string; user_id: string; test_id: string | null; questions_json: unknown; answers_json: unknown };

// quiz_sessions の 1 行を模したメモリ DB。update は .is("answers_json", null)
// 条件を評価し、条件付き更新の原子性（1 行を 1 回だけ更新）を再現する。
function fixture(opts: { row?: Partial<Row>; user?: string | null } = {}) {
  const row: Row = {
    id: sessionId, user_id: userId, test_id: "test-1",
    questions_json: [{ id: "q1", type: "multiple_choice", prompt: "p", choices: ["a", "b"], correctIndex: 0 }],
    answers_json: null, ...opts.row,
  };
  const calls = { grade: 0, stats: 0, updates: 0 };
  const admin = {
    from: (table: string) => {
      assert.equal(table, "quiz_sessions");
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { ...row }, error: null }) }) }),
        update: (values: Partial<Row>) => {
          const filters: Array<(r: Row) => boolean> = [];
          const chain = {
            eq: (col: keyof Row, v: unknown) => { filters.push((r) => r[col] === v); return chain; },
            is: (col: keyof Row, v: null) => { filters.push((r) => r[col] === v); return chain; },
            select: async () => {
              if (!filters.every((f) => f(row))) return { data: [], error: null };
              calls.updates++;
              Object.assign(row, values);
              return { data: [{ id: row.id }], error: null };
            },
          };
          return chain;
        },
      };
    },
  };
  let releaseGrade: (() => void) | null = null;
  const route = loadWithStubs("../app/api/quiz/[sessionId]/submit/route.ts", {
    "next/server": { NextResponse },
    "@/lib/request-json": requestJson,
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
      recordQuestionPerformanceAfterSubmit: async () => { calls.stats++; },
    },
  });
  const post = route.POST as (req: Request, ctx: { params: Promise<{ sessionId: string }> }) => Promise<Response>;
  const submit = () => post(
    new Request("https://unused.invalid/submit", { method: "POST", body: JSON.stringify({ answers: { q1: 0 } }) }),
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
  const f = fixture({ row: { answers_json: { q1: 1 } } });
  const res = await f.submit();
  assert.equal(res.status, 409);
  assert.deepEqual(f.row.answers_json, { q1: 1 });
  assert.deepEqual(f.calls, { grade: 0, stats: 0, updates: 0 });
});

test("submit: 並行 2 提出では 1 件だけ保存され統計は 1 回分だけ増える", async () => {
  const f = fixture();
  const statuses = (await Promise.all([f.submit(), f.submit()])).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
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
