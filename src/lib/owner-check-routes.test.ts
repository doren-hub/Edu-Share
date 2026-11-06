// service role（RLS を迂回）を使う API の所有者確認テスト（Issue #219・#243）。
// Supabase・object-storage・取り込みはモックにし、未ログイン 401・他人 403 では
// DB/R2 への書き込みや削除の関数が呼ばれないこと、本人なら成功することを確かめる。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import * as schemas from "./api-input-schemas.ts";
import * as requestJson from "./request-json.ts";

const require = createRequire(import.meta.url);
const { NextResponse } = require("next/server.js");
const OWNER = "owner-user";
const OTHER = "other-user";
const TEST_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";

type Rows = Record<string, Record<string, unknown> | null>;
const WRITE_OPS = new Set(["insert", "update", "upsert", "delete"]);
const FILTER_METHODS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "is", "in",
  "contains", "containedBy", "like", "ilike", "match", "not", "or", "filter",
]);

type QueryCondition = {
  table: string;
  op: string;
  method: string;
  args: unknown[];
};

type ExpectedCondition = {
  table?: string;
  op?: string;
  method: string;
  args: unknown[];
};

function assertConditionsInclude(
  actualConditions: QueryCondition[],
  expectedConditions: ExpectedCondition[],
  context: string,
) {
  for (const expected of expectedConditions) {
    const found = actualConditions.some((actual) =>
      (!expected.table || actual.table === expected.table) &&
      (!expected.op || actual.op === expected.op) &&
      actual.method === expected.method &&
      actual.args.length === expected.args.length &&
      actual.args.every((arg, i) => arg === expected.args[i]),
    );
    assert.ok(
      found,
      `${context}: 期待するクエリ条件 ${JSON.stringify(expected)} が実行されていません。実際の条件: ${JSON.stringify(actualConditions)}`,
    );
  }
}

/** テーブルごとの固定行を返し、書き込み系呼び出しを writes、クエリ条件を conditions に記録する簡易クライアント。 */
function fakeAdmin(rows: Rows, writes: string[], conditions: QueryCondition[] = []) {
  return {
    rpc: async (name: string) => { writes.push(`rpc:${name}`); return { data: true, error: null }; },
    from: (table: string) => {
      let op = "select";
      const result = (single = false) => op === "select"
        ? (rows[table] ? { data: rows[table], error: null } : { data: null, error: { message: "not found" } })
        : { data: single ? { id: "new-session" } : [{ id: "new-session" }], error: null };
      const builder: Record<string, unknown> = new Proxy({}, {
        get: (_t, prop) => {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, ng: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ng);
          }
          if (prop === "single") return async () => result(true);
          if (prop === "maybeSingle") {
            return async () => (op === "select" && !rows[table] ? { data: null, error: null } : result(true));
          }
          return (...args: unknown[]) => {
            const name = String(prop);
            if (WRITE_OPS.has(name)) {
              op = name;
              writes.push(`${name}:${table}`);
            } else if (FILTER_METHODS.has(name)) {
              conditions.push({ table, op, method: name, args });
            }
            return builder;
          };
        },
      });
      return builder;
    },
  };
}

function loadModule(path: string, stubs: Record<string, unknown>, calls: string[]) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  // 明示しない依存は、呼ばれたら記録して失敗する（想定外の外部呼び出しを検出）。
  const stubRequire = (name: string) => {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    if (name === "crypto" || name === "node:crypto") return require("node:crypto");
    return new Proxy({}, {
      get: (_t, prop) => {
        if (prop === "__esModule" || typeof prop === "symbol") return undefined;
        return () => { calls.push(`${name}.${String(prop)}`); throw new Error(`Unexpected: ${name}.${String(prop)}`); };
      },
    });
  };
  const exports: Record<string, unknown> = {};
  new Function("exports", "require", outputText)(exports, stubRequire);
  return exports;
}

type Extra = (record: (name: string, value?: unknown) => (...a: unknown[]) => Promise<unknown>) => Record<string, unknown>;

async function importPure(path: string) {
  return import(new URL(path, import.meta.url).href);
}
const paperIndustries = await importPure("./paper-industries.ts");

function harness(path: string, opts: { user: string | null; rows: Rows; extra?: Extra }) {
  const writes: string[] = [];
  const calls: string[] = [];
  const conditions: QueryCondition[] = [];
  const record = (name: string, value: unknown = undefined) => async (..._a: unknown[]) => { writes.push(name); return value; };
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/lib/request-json": requestJson,
    "@/lib/llm-rate-limit": { llmRateLimitResponse: () => null },
    "@/lib/api-input-schemas": schemas,
    "@/lib/supabase/server": {
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: opts.user ? { id: opts.user } : null } }) },
        from: () => { throw new Error("RLS クライアントでの書き込みは想定外"); },
      }),
    },
    "@/lib/supabase/admin": { createAdminClient: () => fakeAdmin(opts.rows, writes, conditions) },
    "@/lib/object-storage": {
      deleteObjects: record("r2:delete"),
      copyObject: record("r2:copy"),
      putObject: record("r2:put"),
      createObjectUploadUrl: record("r2:uploadUrl", "https://upload.invalid"),
      getObjectMetadata: async (path: string) => ({ exists: true, size: 50_000, contentType: path.includes("video") ? "video/mp4" : "application/pdf", etag: "etag" }),
      createObjectReadUrl: async () => "https://read.invalid",
    },
    "@/lib/ingest-pdf": { ingestPdfForTest: record("ingest") },
    "@/lib/sanitize-processing-error": { sanitizeProcessingError: (e: unknown) => String(e) },
    "@/lib/test-notebooklm-material-paths": {
      notebooklmSlidePdfStoragePath: (u: string, t: string) => `${u}/${t}/slide.pdf`,
      legacyNotebooklmSlidePdfStoragePath: (u: string, t: string) => `${u}/${t}-slide.pdf`,
      notebooklmVideoMp4StoragePath: (u: string, t: string) => `${u}/${t}/video.mp4`,
      legacyNotebooklmVideoMp4StoragePath: (u: string, t: string) => `${u}/${t}-video.mp4`,
    },
    "@/lib/paper-industries": paperIndustries,
    "@/lib/notebooklm": { NOTEBOOKLM_APP_URL: "https://notebook.invalid" },
    ...opts.extra?.(record),
  };
  // 認証・所有者確認を含む共通実装も実コードで読み込む。
  stubs["@/lib/commit-notebooklm-material"] = loadModule("./commit-notebooklm-material.ts", stubs, calls);
  const route = loadModule(path, stubs, calls) as Record<string, (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  return { route, writes, calls, conditions };
}

const testRow = (owner: string) => ({
  id: TEST_ID, uploaded_by: owner, pdf_storage_path: `${owner}/${TEST_ID}.pdf`,
  document_type: "past_exam", processing_status: "ready",
  notebooklm_slide_pdf_storage_path: null, notebooklm_video_mp4_storage_path: null,
});

function pdfForm() {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([37, 80, 68, 70])], "a.pdf", { type: "application/pdf" }));
  return form;
}

type Case = {
  name: string;
  path: string;
  method: string;
  params: Record<string, string>;
  rows: (owner: string) => Rows;
  request: () => Request;
  /** 本人成功時に期待する書き込み（順序どおり） */
  ownerWrites: string[];
  extra?: Extra;
  /** 存在しない ID に対する応答（省略時は 404）。200 冪等成功など */
  missingResponse?: { status: number; body?: unknown };
  /** 存在しない ID でも 200 冪等成功を返すルート（missingResponse の簡易指定） */
  idempotentMissing?: boolean;
  /** 未認証・他人の不正な本文を解析しないことを検証するケースか */
  assertsOwnerBeforeBody?: boolean;
  /** 本人による不正な JSON を所有者確認後に拒否することを検証するケースか */
  rejectsMalformedJsonAfterOwnerCheck?: boolean;
  /** 再出題元セッションの所有者確認を検証するケースか */
  reuseSessionCase?: boolean;
  /** 本人成功時の書き込み（update/delete）に含まれるべきクエリ条件 */
  expectedConditions?: ExpectedCondition[];
};

const json = (body: unknown) => () => new Request("https://unused.invalid/x", { method: "POST", body: JSON.stringify(body) });

const cases: Case[] = [
  {
    name: "tests PATCH", path: "../app/api/tests/[id]/route.ts", method: "PATCH", params: { id: TEST_ID },
    rows: (o) => ({ tests: testRow(o) }), request: json({ title: "新しいタイトル" }),
    ownerWrites: ["update:tests"],
    expectedConditions: [
      { table: "tests", op: "update", method: "eq", args: ["id", TEST_ID] },
    ],
    assertsOwnerBeforeBody: true,
    rejectsMalformedJsonAfterOwnerCheck: true,
  },
  {
    name: "tests DELETE", path: "../app/api/tests/[id]/route.ts", method: "DELETE", params: { id: TEST_ID },
    rows: (o) => ({ tests: testRow(o) }), request: json({}),
    ownerWrites: ["r2:delete", "delete:tests"],
    expectedConditions: [
      { table: "tests", op: "delete", method: "eq", args: ["id", TEST_ID] },
    ],
  },
  {
    name: "tests/pdf POST", path: "../app/api/tests/[id]/pdf/route.ts", method: "POST", params: { id: TEST_ID },
    rows: (o) => ({ tests: testRow(o) }),
    request: () => new Request("https://unused.invalid/x", { method: "POST", body: pdfForm() }),
    ownerWrites: ["update:tests", "r2:put", "ingest"],
    expectedConditions: [
      { table: "tests", op: "update", method: "eq", args: ["id", TEST_ID] },
    ],
    assertsOwnerBeforeBody: true,
  },
  {
    name: "material/slide commit", path: "../app/api/tests/[id]/material/slide/commit/route.ts", method: "POST",
    params: { id: TEST_ID }, rows: (o) => ({ tests: { ...testRow(o), pdf_storage_path: null } }), request: json({ action: "commit", path: `${OWNER}/${TEST_ID}-notebooklm-slide-upload-${SESSION_ID}.pdf` }),
    ownerWrites: ["r2:copy", "update:tests", "r2:delete"],
    expectedConditions: [
      { table: "tests", op: "update", method: "eq", args: ["id", TEST_ID] },
      { table: "tests", op: "update", method: "eq", args: ["uploaded_by", OWNER] },
    ],
    assertsOwnerBeforeBody: true,
  },
  {
    name: "material/video commit", path: "../app/api/tests/[id]/material/video/commit/route.ts", method: "POST",
    params: { id: TEST_ID }, rows: (o) => ({ tests: testRow(o) }), request: json({ action: "commit", path: `${OWNER}/${TEST_ID}-notebooklm-video-upload-${SESSION_ID}.mp4` }),
    ownerWrites: ["r2:copy", "update:tests", "r2:delete"],
    expectedConditions: [
      { table: "tests", op: "update", method: "eq", args: ["id", TEST_ID] },
      { table: "tests", op: "update", method: "eq", args: ["uploaded_by", OWNER] },
    ],
    assertsOwnerBeforeBody: true,
  },
  ...(["slide", "video"] as const).flatMap((kind): Case[] => [
    {
      name: `material/${kind} POST`, path: `../app/api/tests/[id]/material/${kind}/route.ts`, method: "POST",
      params: { id: TEST_ID }, rows: (o) => ({ tests: testRow(o) }), request: json({}),
      ownerWrites: ["multipart", "r2:put", "r2:delete", "update:tests"],
      expectedConditions: [
        { table: "tests", op: "update", method: "eq", args: ["id", TEST_ID] },
      ],
      assertsOwnerBeforeBody: true,
      extra: (record) => ({
        "@/lib/multipart-file-stream": {
          processMultipartFileUpload: async (_req: Request, _opts: unknown, upload: (stream: unknown) => Promise<void>) => {
            await record("multipart")();
            await upload(new Uint8Array());
            return { ok: true };
          },
        },
      }),
    },
    {
      name: `material/${kind} DELETE`, path: `../app/api/tests/[id]/material/${kind}/route.ts`, method: "DELETE",
      params: { id: TEST_ID }, rows: (o) => ({ tests: testRow(o) }), request: json({}),
      ownerWrites: ["update:tests", "r2:delete"],
      expectedConditions: [
        { table: "tests", op: "update", method: "eq", args: ["id", TEST_ID] },
      ],
    },
  ]),
  {
    name: "tests summarize", path: "../app/api/tests/[id]/summarize/route.ts", method: "POST",
    params: { id: TEST_ID }, rows: (o) => ({ tests: testRow(o) }), request: json({}),
    ownerWrites: ["r2:read", "pdf:extract", "llm:summary"],
    assertsOwnerBeforeBody: true,
    extra: (record) => ({
      "@/lib/object-storage": { getObjectBytes: record("r2:read", new Uint8Array()) },
      "@/lib/pdf-text-by-page": { extractPdfTextByPage: record("pdf:extract", ["本文"]) },
      "@/lib/pdf-summary.ts": { summarizeByLlm: record("llm:summary", "要約") },
    }),
  },
  {
    name: "quiz DELETE", path: "../app/api/quiz/[sessionId]/route.ts", method: "DELETE", params: { sessionId: SESSION_ID },
    rows: (o) => ({ quiz_sessions: { id: SESSION_ID, user_id: o } }), request: json({}),
    ownerWrites: ["delete:quiz_sessions"],
    expectedConditions: [
      { table: "quiz_sessions", op: "delete", method: "eq", args: ["id", SESSION_ID] },
    ],
    idempotentMissing: true,
  },
  {
    name: "quiz submit", path: "../app/api/quiz/[sessionId]/submit/route.ts", method: "POST", params: { sessionId: SESSION_ID },
    rows: (o) => ({
      quiz_sessions: {
        id: SESSION_ID, user_id: o, test_id: TEST_ID, answers_json: null,
        questions_json: [{ id: "q1", type: "multiple_choice", prompt: "p", choices: ["a", "b"], correctIndex: 0 }],
      },
    }),
    request: json({ answers: { q1: 0 } }),
    ownerWrites: ["rpc:claim_quiz_grading", "llm:grade", "rpc:submit_quiz_with_performance", "rpc:release_quiz_grading"],
    assertsOwnerBeforeBody: true,
    rejectsMalformedJsonAfterOwnerCheck: true,
    extra: (record) => ({
      "@/lib/claude-quiz": { gradeWithClaude: record("llm:grade", { scoreMc: 1, scoreEssay: 0, scoreTotal: 1, feedback: {} }) },
      "@/lib/question-performance": { buildQuestionPerformanceAttempts: () => [] },
    }),
  },
  {
    name: "tests start（再出題元セッション）", path: "../app/api/tests/[id]/start/route.ts", method: "POST", params: { id: TEST_ID },
    rows: (o) => ({
      tests: testRow(OWNER),
      quiz_sessions: {
        id: SESSION_ID, test_id: TEST_ID, user_id: o, notebook_lm_csv_pool: null,
        questions_json: [{ id: "q1", type: "multiple_choice", prompt: "p", choices: ["a", "b"], correctIndex: 0 }],
      },
    }),
    request: json({ reuseQuestionsFromSessionId: SESSION_ID }),
    ownerWrites: ["insert:quiz_sessions"],
    reuseSessionCase: true,
    extra: () => ({
      "@/lib/claude-quiz": { stripForClient: (qs: unknown[]) => qs },
      "@/lib/quiz-session-mode": {
        inferQuizSessionMaterialMode: () => "standard",
        inferNotebookLmCsvPoolKindFromQuestions: () => null,
        buildCsvQuestionPerformanceKeySet: () => new Set(),
      },
    }),
  },
];

for (const c of cases) {
  const run = (user: string | null) => harness(c.path, { user, rows: c.rows(OWNER), extra: c.extra });
  const call = (h: ReturnType<typeof run>) => h.route[c.method](c.request(), { params: Promise.resolve(c.params) });

  test(`${c.name}: 未ログインは 401 で書き込まない`, async () => {
    const h = run(null);
    assert.equal((await call(h)).status, 401);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.calls, []);
  });

  test(`${c.name}: 他人は 403 で DB・R2 に書き込まない`, async () => {
    const h = run(OTHER);
    assert.equal((await call(h)).status, 403);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.calls, []);
  });

  test(`${c.name}: 存在しない ID では外部処理・書き込みをしない`, async () => {
    const h = harness(c.path, { user: OWNER, rows: {}, extra: c.extra });
    const res = await call(h);
    // DELETE は既存の冪等な成功応答を維持する。
    const expectedStatus = c.missingResponse?.status ?? (c.idempotentMissing ? 200 : 404);
    assert.equal(res.status, expectedStatus);
    const expectedBody = c.missingResponse?.body ?? (c.idempotentMissing ? { ok: true, deleted: false } : undefined);
    if (expectedBody !== undefined) {
      assert.deepEqual(await res.json(), expectedBody);
    }
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.calls, []);
  });

  if (c.assertsOwnerBeforeBody) {
    test(`${c.name}: 未認証・他人の不正な本文を解析しない`, async () => {
      for (const user of [null, OTHER]) {
        const h = run(user);
        const req = new Request("https://unused.invalid/x", { method: c.method, body: "{" });
        const res = await h.route[c.method](req, { params: Promise.resolve(c.params) });
        assert.equal(res.status, user === null ? 401 : 403);
        assert.equal(req.bodyUsed, false);
        assert.deepEqual(h.writes, []);
        assert.deepEqual(h.calls, []);
      }
    });
  }

  test(`${c.name}: 本人なら成功する`, async () => {
    const h = run(OWNER);
    const res = await call(h);
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(h.writes, c.ownerWrites);
    assert.deepEqual(h.calls, []);
    if (c.expectedConditions) {
      assertConditionsInclude(h.conditions, c.expectedConditions, c.name);
    }
  });
}

test("クエリ条件検証: 必要な条件（uploaded_by や id）が欠落した退行を検出できる", () => {
  const recorded: QueryCondition[] = [
    { table: "tests", op: "update", method: "eq", args: ["id", TEST_ID] },
  ];
  assert.throws(
    () =>
      assertConditionsInclude(
        recorded,
        [{ table: "tests", op: "update", method: "eq", args: ["uploaded_by", OWNER] }],
        "regression check",
      ),
    /uploaded_by/,
  );
  assert.throws(
    () =>
      assertConditionsInclude(
        [],
        [{ table: "tests", op: "update", method: "eq", args: ["id", TEST_ID] }],
        "regression check",
      ),
    /id/,
  );
});

for (const c of cases.filter((c) => c.rejectsMalformedJsonAfterOwnerCheck)) {
  test(`${c.name}: 本人の不正な JSON は所有者確認後に拒否する`, async () => {
    const h = harness(c.path, { user: OWNER, rows: c.rows(OWNER), extra: c.extra });
    const req = new Request("https://unused.invalid/x", { method: c.method, body: "{" });
    const res = await h.route[c.method](req, { params: Promise.resolve(c.params) });
    assert.equal(res.status, 400);
    assert.equal(req.bodyUsed, true);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.calls, []);
  });
}

const reuseCase = cases.find((c) => c.reuseSessionCase)!;

test("再出題: 参照元セッションが存在しない場合は 404 で書き込まない", async () => {
  const h = harness(reuseCase.path, { user: OWNER, rows: { tests: testRow(OWNER) }, extra: reuseCase.extra });
  const res = await h.route.POST(reuseCase.request(), { params: Promise.resolve(reuseCase.params) });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "参照元のセッションが見つかりません" });
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.calls, []);
});

test("再出題: 他人のセッションは教材との関連検査より先に拒否する", async () => {
  const rows = reuseCase.rows(OTHER);
  rows.quiz_sessions = { ...rows.quiz_sessions, test_id: "another-test" };
  const h = harness(reuseCase.path, { user: OWNER, rows, extra: reuseCase.extra });
  const res = await h.route.POST(reuseCase.request(), { params: Promise.resolve(reuseCase.params) });
  assert.equal(res.status, 403);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.calls, []);
});

test("再出題: 共有教材でも本人のセッションなら利用できる", async () => {
  const h = harness(reuseCase.path, { user: OTHER, rows: reuseCase.rows(OTHER), extra: reuseCase.extra });
  const res = await h.route.POST(reuseCase.request(), { params: Promise.resolve(reuseCase.params) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(h.writes, reuseCase.ownerWrites);
  assert.deepEqual(h.calls, []);
});

for (const [path, method, status] of [
  ["../app/api/tests/[id]/pdf/route.ts", "GET", 307],
  ["../app/api/tests/[id]/notebooklm/prepare/route.ts", "POST", 200],
] as const) {
  test(`${path}: 共有 PDF はログイン済みの他ユーザーも閲覧できる`, async () => {
    const h = harness(path, { user: OTHER, rows: { tests: testRow(OWNER) } });
    const res = await h.route[method](new Request("https://unused.invalid/x", { method }), {
      params: Promise.resolve({ id: TEST_ID }),
    });
    assert.equal(res.status, status);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.calls, []);
  });

  test(`${path}: 存在しない ID では 404 で外部処理を行わない`, async () => {
    const h = harness(path, { user: OWNER, rows: {} });
    const res = await h.route[method](new Request("https://unused.invalid/x", { method }), {
      params: Promise.resolve({ id: TEST_ID }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.calls, []);
  });
}
