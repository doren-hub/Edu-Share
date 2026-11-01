// service role（RLS を迂回）で書き込む API の所有者確認テスト（Issue #219）。
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

/** テーブルごとの固定行を返し、書き込み系の呼び出しを writes に記録する簡易クライアント。 */
function fakeAdmin(rows: Rows, writes: string[]) {
  return {
    rpc: async (name: string) => { writes.push(`rpc:${name}`); return { data: null, error: null }; },
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
          return (..._args: unknown[]) => {
            const name = String(prop);
            if (WRITE_OPS.has(name)) {
              op = name;
              writes.push(`${name}:${table}`);
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
    "@/lib/supabase/admin": { createAdminClient: () => fakeAdmin(opts.rows, writes) },
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
    ...opts.extra?.(record),
  };
  // 認証・所有者確認を含む共通実装も実コードで読み込む。
  stubs["@/lib/commit-notebooklm-material"] = loadModule("./commit-notebooklm-material.ts", stubs, calls);
  const route = loadModule(path, stubs, calls) as Record<string, (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  return { route, writes, calls };
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
};

const json = (body: unknown) => () => new Request("https://unused.invalid/x", { method: "POST", body: JSON.stringify(body) });

const cases: Case[] = [
  {
    name: "tests PATCH", path: "../app/api/tests/[id]/route.ts", method: "PATCH", params: { id: TEST_ID },
    rows: (o) => ({ tests: testRow(o) }), request: json({ title: "新しいタイトル" }),
    ownerWrites: ["update:tests"],
  },
  {
    name: "tests DELETE", path: "../app/api/tests/[id]/route.ts", method: "DELETE", params: { id: TEST_ID },
    rows: (o) => ({ tests: testRow(o) }), request: json({}),
    ownerWrites: ["r2:delete", "delete:tests"],
  },
  {
    name: "tests/pdf POST", path: "../app/api/tests/[id]/pdf/route.ts", method: "POST", params: { id: TEST_ID },
    rows: (o) => ({ tests: testRow(o) }),
    request: () => new Request("https://unused.invalid/x", { method: "POST", body: pdfForm() }),
    ownerWrites: ["update:tests", "r2:put", "ingest"],
  },
  {
    name: "material/slide commit", path: "../app/api/tests/[id]/material/slide/commit/route.ts", method: "POST",
    params: { id: TEST_ID }, rows: (o) => ({ tests: { ...testRow(o), pdf_storage_path: null } }), request: json({ action: "commit", path: `${OWNER}/${TEST_ID}-notebooklm-slide-upload-${SESSION_ID}.pdf` }),
    ownerWrites: ["r2:copy", "update:tests", "r2:delete"],
  },
  {
    name: "material/video commit", path: "../app/api/tests/[id]/material/video/commit/route.ts", method: "POST",
    params: { id: TEST_ID }, rows: (o) => ({ tests: testRow(o) }), request: json({ action: "commit", path: `${OWNER}/${TEST_ID}-notebooklm-video-upload-${SESSION_ID}.mp4` }),
    ownerWrites: ["r2:copy", "update:tests", "r2:delete"],
  },
  {
    name: "quiz DELETE", path: "../app/api/quiz/[sessionId]/route.ts", method: "DELETE", params: { sessionId: SESSION_ID },
    rows: (o) => ({ quiz_sessions: { id: SESSION_ID, user_id: o } }), request: json({}),
    ownerWrites: ["delete:quiz_sessions"],
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
    ownerWrites: ["llm:grade", "update:quiz_sessions", "stats"],
    extra: (record) => ({
      "@/lib/claude-quiz": { gradeWithClaude: record("llm:grade", { scoreMc: 1, scoreEssay: 0, scoreTotal: 1, feedback: {} }) },
      "@/lib/question-performance": { recordQuestionPerformanceAfterSubmit: record("stats") },
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

  test(`${c.name}: 本人なら成功する`, async () => {
    const h = run(OWNER);
    const res = await call(h);
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(h.writes, c.ownerWrites);
    assert.deepEqual(h.calls, []);
  });
}
