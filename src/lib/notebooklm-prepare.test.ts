import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function fixture(options: {
  status?: string; path?: string | null; exists?: boolean; storageError?: boolean;
  signingError?: boolean; loggedIn?: boolean; missingRow?: boolean; dbError?: boolean;
} = {}) {
  const events: string[] = [];
  const path = options.path === undefined ? "owner/original.pdf" : options.path;
  const query = {
    select: () => query,
    eq: () => query,
    single: async () => ({
      data: options.missingRow ? null : { processing_status: options.status ?? "failed", pdf_storage_path: path },
      error: options.dbError ? { message: "unavailable" } : null,
    }),
  };
  const stubs: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: options.loggedIn === false ? null : { id: "reader" } } }) } }) },
    "@/lib/supabase/admin": { createAdminClient: () => ({ from: () => query }) },
    "@/lib/notebooklm": { NOTEBOOKLM_APP_URL: "https://notebooklm.invalid" },
    "@/lib/object-storage": {
      getObjectMetadata: async (key: string) => {
        assert.equal(key, path);
        events.push("head");
        if (options.storageError) throw new Error("private storage error");
        return { exists: options.exists ?? true };
      },
      createObjectReadUrl: async (key: string, ttl: number) => {
        assert.equal(key, path);
        assert.equal(ttl, 3600);
        events.push("sign");
        if (options.signingError) throw new Error("signing failed");
        return "https://pdf.invalid/original.pdf";
      },
    },
  };
  const source = readFileSync(new URL("../app/api/tests/[id]/notebooklm/prepare/route.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: { POST?: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> } = {};
  new Function("exports", "require", outputText)(exports, (name: string) => {
    assert.ok(Object.hasOwn(stubs, name), `Unexpected dependency: ${name}`);
    return stubs[name];
  });
  return {
    events,
    run: () => exports.POST!(new Request("https://app.invalid", { method: "POST" }), { params: Promise.resolve({ id: "paper" }) }),
  };
}

test("recovered failed row with an unsaved PDF returns reupload guidance without signing", async () => {
  const f = fixture({ exists: false });
  const response = await f.run();
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error, /アップロードしたユーザー.*PDFを再アップロード/);
  assert.equal(body.signedUrl, undefined);
  assert.deepEqual(f.events, ["head"]);
});

for (const status of ["ready", "failed"]) {
  test(`${status}: existing PDF remains available, including old PDF after replacement failure`, async () => {
    const f = fixture({ status });
    const before = Date.now();
    const response = await f.run();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.signedUrl, "https://pdf.invalid/original.pdf");
    assert.equal(body.expiresInSeconds, 3600);
    assert.ok(Date.parse(body.expiresAt) >= before + 3600_000);
    assert.equal(body.notebookLmAppUrl, "https://notebooklm.invalid");
    assert.deepEqual(f.events, ["head", "sign"]);
  });
}

test("storage check errors fail closed and invite retry rather than asserting PDF loss", async () => {
  const f = fixture({ storageError: true });
  const response = await f.run();
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /時間をおいて/);
  assert.doesNotMatch(JSON.stringify(body), /再アップロード|private storage error/);
  assert.equal(body.signedUrl, undefined);
  assert.deepEqual(f.events, ["head"]);
});

test("authentication and row visibility checks precede storage access", async () => {
  for (const options of [{ loggedIn: false }, { status: "pending" }, { path: null }, { missingRow: true }, { dbError: true }]) {
    const f = fixture(options);
    assert.equal((await f.run()).status, options.loggedIn === false ? 401 : 404);
    assert.deepEqual(f.events, []);
  }
});

test("ready row with missing object also cannot issue a broken URL", async () => {
  const f = fixture({ status: "ready", exists: false });
  assert.equal((await f.run()).status, 404);
  assert.deepEqual(f.events, ["head"]);
});

test("signing failure after successful HEAD does not return a URL", async () => {
  const f = fixture({ signingError: true });
  const response = await f.run();
  assert.equal(response.status, 500);
  assert.equal((await response.json()).signedUrl, undefined);
  assert.deepEqual(f.events, ["head", "sign"]);
});
