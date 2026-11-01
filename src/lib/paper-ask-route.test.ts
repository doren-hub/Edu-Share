import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import * as schemas from "./api-input-schemas.ts";
import * as requestJson from "./request-json.ts";
import * as rateLimit from "./paper-ask-rate-limit.ts";

const require = createRequire(import.meta.url);
const { NextResponse } = require("next/server.js");
const paperId = "11111111-1111-4111-8111-111111111111";
const userId = "test-ask-user";

// Execute the real handler and cookie adapter, replacing only framework/service
// boundaries. Unexpected imports fail closed: no credentials or network clients.
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
  new Function("exports", "require", "process", outputText)(exports, stubRequire, {
    env: { NEXT_PUBLIC_SUPABASE_URL: "https://unused.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake" },
  });
  return exports;
}

function fixture(authenticated = true) {
  rateLimit.resetUserAskRateLimitForTests();
  const events: string[] = [];
  const cookieWrites: unknown[][] = [];
  const server = loadWithStubs("./supabase/server.ts", {
    "next/headers": {
      cookies: async () => ({
        getAll: () => [{ name: "session", value: "old" }],
        set: (...args: unknown[]) => cookieWrites.push(args),
      }),
    },
    "@supabase/ssr": {
      createServerClient: (_url: string, _key: string, options: {
        cookies: { getAll(): unknown; setAll(values: unknown[]): void };
      }) => ({
        auth: {
          getUser: async () => {
            events.push("auth");
            assert.deepEqual(options.cookies.getAll(), [{ name: "session", value: "old" }]);
            options.cookies.setAll([{ name: "session", value: "refreshed", options: { httpOnly: true, path: "/" } }]);
            return { data: { user: authenticated ? { id: userId } : null } };
          },
        },
      }),
    },
  });
  const answer = { answer: "回答", referencedChunks: [] };
  const route = loadWithStubs("../app/api/papers/[id]/ask/route.ts", {
    "next/server": { NextResponse },
    "@/lib/request-json": requestJson,
    "@/lib/api-input-schemas": schemas,
    "@/lib/supabase/server": server,
    "@/lib/supabase/admin": {
      createAdminClient: () => {
        events.push("admin");
        return {
          from: (table: string) => ({
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { id: paperId, document_type: "paper", processing_status: "ready" } }),
                order: async () => {
                  assert.equal(table, "document_chunks");
                  return { data: [{ id: "chunk-1", chunk_index: 0, content: "本文", pdf_page: 1 }] };
                },
              }),
            }),
          }),
        };
      },
    },
    "@/lib/paper-ask-rate-limit": {
      checkUserAskRateLimit: (id: string) => {
        events.push("rate");
        assert.equal(id, userId);
        return rateLimit.checkUserAskRateLimit(id);
      },
    },
    "@/lib/embeddings": {
      openAiEmbeddingsEnabled: () => { throw new Error("Unexpected embedding call"); },
      embedQuery: () => { throw new Error("Unexpected embedding call"); },
    },
    "@/lib/paper-ask": {
      askPaperQuestion: async (input: { question: string; history: unknown; allChunks: unknown[] }) => {
        events.push("answer");
        assert.equal(input.question, "質問");
        assert.deepEqual(input.history, [{ role: "assistant", content: "前の回答" }]);
        assert.deepEqual(input.allChunks, [{ id: "chunk-1", chunk_index: 0, content: "本文", pdf_page: 1 }]);
        return answer;
      },
    },
  });
  const post = route.POST as (req: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  return {
    events, answer,
    post: (req: Request, id = paperId) => post(req, { params: Promise.resolve({ id }) }),
    assertCookies: () => assert.deepEqual(cookieWrites, [["session", "refreshed", { httpOnly: true, path: "/" }]]),
  };
}

function bodyRequest(text: string, headers: Record<string, string> = {}) {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const req = new Request("https://unused.invalid/ask", {
    method: "POST", headers, body: stream, duplex: "half",
  } as RequestInit);
  return { req, reads: () => reads };
}

const validBody = JSON.stringify({ question: "質問", history: [{ role: "assistant", content: "前の回答" }] });

test("ask: invalid id precedes auth and body validation", async () => {
  const f = fixture(false);
  const body = bodyRequest("{");
  assert.equal((await f.post(body.req, "invalid")).status, 400);
  assert.equal(body.reads(), 0);
  assert.deepEqual(f.events, []);
});

for (const [name, text, headers] of [
  ["valid", validBody, {}],
  ["malformed", "{", {}],
  ["oversized stream", "x".repeat(requestJson.API_BODY_LIMITS.paperAsk + 1), {}],
  ["oversized declaration", "", { "content-length": String(requestJson.API_BODY_LIMITS.paperAsk + 1) }],
] as const) {
  test(`ask: unauthenticated ${name} body is not read (401)`, async () => {
    const f = fixture(false);
    const body = bodyRequest(text, headers);
    const res = await f.post(body.req);
    assert.equal(res.status, 401);
    assert.equal(body.reads(), 0);
    assert.equal(body.req.bodyUsed, false);
    assert.deepEqual(f.events, ["auth"]);
    f.assertCookies();
  });

  test(`ask: rate-limited ${name} body is not read (429)`, async () => {
    const f = fixture();
    for (let i = 0; i < rateLimit.ASK_RATE_LIMIT_MAX_REQUESTS; i++) rateLimit.checkUserAskRateLimit(userId);
    const body = bodyRequest(text, headers);
    const res = await f.post(body.req);
    assert.equal(res.status, 429);
    const result = await res.json();
    assert.ok(result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 60);
    assert.equal(body.reads(), 0);
    assert.equal(body.req.bodyUsed, false);
    assert.deepEqual(f.events, ["auth", "rate"]);
    f.assertCookies();
  });
}

for (const [name, text, status] of [
  ["valid", validBody, 200],
  ["at byte limit", validBody + " ".repeat(requestJson.API_BODY_LIMITS.paperAsk - Buffer.byteLength(validBody)), 200],
  ["over byte limit", validBody + " ".repeat(requestJson.API_BODY_LIMITS.paperAsk + 1 - Buffer.byteLength(validBody)), 413],
  ["malformed JSON", "{", 400],
  ["invalid schema", '{"question":""}', 400],
] as const) {
  test(`ask: authenticated ${name} preserves validation and cookie refresh`, async () => {
    const f = fixture();
    const body = bodyRequest(text);
    const res = await f.post(body.req);
    assert.equal(res.status, status);
    assert.ok(body.reads() > 0);
    assert.deepEqual(f.events, status === 200 ? ["auth", "rate", "admin", "answer"] : ["auth", "rate"]);
    if (status === 200) assert.deepEqual(await res.json(), f.answer);
    f.assertCookies();
  });
}

test("ask: invalid authenticated bodies consume quota before being read", async () => {
  const f = fixture();
  for (let i = 0; i < rateLimit.ASK_RATE_LIMIT_MAX_REQUESTS; i++) {
    assert.equal((await f.post(bodyRequest("{").req)).status, 400);
  }
  const body = bodyRequest(validBody);
  assert.equal((await f.post(body.req)).status, 429);
  assert.equal(body.reads(), 0);
});
