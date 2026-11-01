import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import * as limiter from "./llm-rate-limit.ts";

const require = createRequire(import.meta.url);
const { NextResponse } = require("next/server.js");
const userId = "rate-user";

// 認証とレート制限以外の依存は、触れた瞬間に記録して失敗する Proxy にする。
// 制限超過時に LLM・DB・ストレージへ到達しないことを確認するため。
function loadRoute(path: string, touched: string[]) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false },
  });
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/lib/llm-rate-limit": limiter,
    "@/lib/supabase/server": {
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: userId } } }) } }),
    },
  };
  const stubRequire = (name: string) => {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    return new Proxy({}, {
      get: (_t, prop) => {
        if (prop === "__esModule" || typeof prop === "symbol") return undefined;
        return (..._args: unknown[]) => {
          touched.push(`${name}.${String(prop)}`);
          throw new Error(`Unexpected call: ${name}.${String(prop)}`);
        };
      },
    });
  };
  const exports: Record<string, unknown> = {};
  new Function("exports", "require", outputText)(exports, stubRequire);
  return exports.POST as (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
}

const routes = [
  ["start", "../app/api/tests/[id]/start/route.ts", "quizStart", { id: "t" }],
  ["submit", "../app/api/quiz/[sessionId]/submit/route.ts", "quizSubmit", { sessionId: "s" }],
  ["upload summarize", "../app/api/tests/upload/summarize/route.ts", "summarize", {}],
  ["test summarize", "../app/api/tests/[id]/summarize/route.ts", "summarize", { id: "t" }],
] as const;

for (const [name, path, kind, params] of routes) {
  test(`${name}: 制限超過時は 429 + Retry-After を返し LLM などを呼ばない`, async () => {
    limiter.resetLlmRateLimitForTests();
    for (let i = 0; i < limiter.LLM_RATE_LIMITS[kind].maxRequests; i++) {
      assert.equal(limiter.checkLlmRateLimit(kind, userId).allowed, true);
    }
    const touched: string[] = [];
    const post = loadRoute(path, touched);
    const req = new Request("https://unused.invalid/x", { method: "POST", body: "{}" });
    const res = await post(req, { params: Promise.resolve(params) });
    assert.equal(res.status, 429);
    const retry = Number(res.headers.get("Retry-After"));
    assert.ok(retry >= 1 && retry <= 60);
    assert.equal((await res.json()).retryAfterSeconds, retry);
    assert.deepEqual(touched, []);
    assert.equal(req.bodyUsed, false);
  });
}

test("checkLlmRateLimit: 窓が過ぎると再び許可し、ユーザー・種類ごとに独立", () => {
  limiter.resetLlmRateLimitForTests();
  const { maxRequests, windowMs } = limiter.LLM_RATE_LIMITS.summarize;
  for (let i = 0; i < maxRequests; i++) limiter.checkLlmRateLimit("summarize", "a", 1000);
  assert.equal(limiter.checkLlmRateLimit("summarize", "a", 1000).allowed, false);
  assert.equal(limiter.checkLlmRateLimit("summarize", "b", 1000).allowed, true);
  assert.equal(limiter.checkLlmRateLimit("quizStart", "a", 1000).allowed, true);
  assert.equal(limiter.checkLlmRateLimit("summarize", "a", 1000 + windowMs + 1).allowed, true);
});
