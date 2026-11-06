import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import ts from "typescript";
import { processMultipartFileUpload } from "./multipart-file-stream.ts";
import * as validators from "./pdfs-bucket-upload.ts";
import * as paths from "./test-notebooklm-material-paths.ts";
import { PayloadTooLargeError } from "./object-storage.ts";

function fixture(kind: "slide" | "video", opts: {
  oldPath?: string | null; dbError?: boolean; hiddenSuccess?: boolean; conflict?: boolean;
  storageError?: boolean; tooLarge?: boolean; cleanupError?: boolean; concurrent?: boolean;
} = {}) {
  const ext = kind === "slide" ? "pdf" : "mp4";
  const column = `notebooklm_${kind}_${ext}_storage_path`;
  const fixed = kind === "slide" ? paths.notebooklmSlidePdfStoragePath("owner", "paper") : paths.notebooklmVideoMp4StoragePath("owner", "paper");
  const legacy = kind === "slide" ? paths.legacyNotebooklmSlidePdfStoragePath("owner", "paper") : paths.legacyNotebooklmVideoMp4StoragePath("owner", "paper");
  const oldPath = opts.oldPath === undefined ? `owner/paper-notebooklm-${kind}-${randomUUID()}.${ext}` : opts.oldPath;
  const objects = new Map([[fixed, "fixed"], [legacy, "legacy"], ["original.pdf", "original"]]);
  if (oldPath) objects.set(oldPath, "previous");
  let published = oldPath;
  let reads = 0;
  let releaseReads: () => void;
  const bothRead = new Promise<void>(resolve => { releaseReads = resolve; });
  const events: string[] = [];
  const writes: string[] = [];
  const stubs: Record<string, unknown> = {
    "node:crypto": { randomUUID },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }) },
    "@/lib/supabase/admin": { createAdminClient: () => ({ from: () => {
      let update: Record<string, string> | undefined;
      const guards: Record<string, unknown> = {};
      const query = {
        eq: (key: string, value: unknown) => { guards[key] = value; return query; },
        is: (key: string, value: unknown) => { guards[key] = value; return query; },
        single: async () => {
          const snapshot = published;
          if (opts.concurrent) {
            if (++reads === 2) releaseReads!();
            await bothRead;
          }
          return { data: { id: "paper", uploaded_by: "owner", pdf_storage_path: "original.pdf", [column]: snapshot }, error: null };
        },
        update: (value: Record<string, string>) => { update = value; return query; },
        select: (_columns: string): any => {
          if (!update) return query;
          events.push("db");
          assert.equal(guards.id, "paper");
          assert.equal(guards.uploaded_by, "owner");
          assert.ok(Object.hasOwn(guards, column));
          const changed = !opts.conflict && guards[column] === published;
          if (changed && (!opts.dbError || opts.hiddenSuccess)) published = update[column];
          return Promise.resolve({ data: changed ? [{ id: "paper" }] : [], error: opts.dbError ? { message: "unavailable" } : null });
        },
      };
      return query;
    } }) },
    "@/lib/pdfs-bucket-upload": validators,
    "@/lib/test-notebooklm-material-paths": paths,
    "@/lib/multipart-file-stream": { processMultipartFileUpload },
    "@/lib/object-storage": {
      putObject: async (key: string, body: AsyncIterable<Uint8Array>, type: string, options: { maxBytes: number }) => {
        writes.push(key); events.push("put");
        assert.notEqual(key, oldPath); assert.notEqual(key, fixed); assert.notEqual(key, legacy);
        assert.equal(type, kind === "slide" ? "application/pdf" : "video/mp4");
        assert.equal(options.maxBytes, (kind === "slide" ? 45 : 200) * 1024 * 1024);
        let bytes = "";
        for await (const chunk of body) bytes += Buffer.from(chunk).toString();
        objects.set(key, bytes);
        if (opts.tooLarge) throw new PayloadTooLargeError(options.maxBytes, options.maxBytes + 1);
        if (opts.storageError) throw new Error("upload failed");
      },
      deleteObjects: async (keys: (string | null | undefined)[]) => {
        events.push("cleanup");
        if (opts.cleanupError) throw new Error("cleanup failed");
        for (const key of keys) if (key) objects.delete(key);
      },
    },
  };
  const source = readFileSync(new URL(`../app/api/tests/[id]/material/${kind}/route.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, any> = {};
  new Function("exports", "require", outputText)(exports, (name: string) => {
    assert.ok(Object.hasOwn(stubs, name), name); return stubs[name];
  });
  return {
    objects, events, oldPath, fixed, legacy, writes, published: () => published,
    run: async (invalid = false, malformed = false) => {
      const form = new FormData();
      form.set("file", new File(["new material"], invalid ? "bad.txt" : `material.${ext}`, { type: invalid ? "text/plain" : kind === "slide" ? "application/pdf" : "video/mp4" }));
      // Materialize the client payload before simulating an incoming server request.
      // Cancelling Node's lazily encoded FormData body can reject after a test ends.
      const encoded = new Response(form);
      const bytes = await encoded.arrayBuffer();
      const req = malformed ? new Request("https://app.invalid", { method: "POST", headers: { "content-type": "multipart/form-data" }, body: "bad" }) : new Request("https://app.invalid", {
        method: "POST", headers: { "content-type": encoded.headers.get("content-type")! }, body: bytes,
      });
      return exports.POST(req, { params: Promise.resolve({ id: "paper" }) }) as Promise<Response>;
    },
  };
}

for (const kind of ["slide", "video"] as const) {
  for (const previous of [undefined, null, "fixed", "legacy", "original.pdf"] as const) {
    test(`${kind}: publish then clean previous reference (${previous})`, async () => {
      const baseline = fixture(kind);
      const oldPath = previous === "fixed" ? baseline.fixed : previous === "legacy" ? baseline.legacy : previous;
      const f = fixture(kind, { oldPath });
      const response = await f.run();
      assert.equal(response.status, 200);
      const { path } = await response.json();
      assert.equal(f.published(), path);
      assert.equal(f.objects.get(path), "new material");
      assert.deepEqual(f.events, ["put", "db", "cleanup"]);
      if (f.oldPath && f.oldPath !== "original.pdf") assert.equal(f.objects.has(f.oldPath), false);
      assert.equal(f.objects.has(f.fixed), false);
      assert.equal(f.objects.has(f.legacy), false);
      assert.equal(f.objects.has("original.pdf"), true);
    });
  }
  for (const failure of ["invalid", "malformed", "storageError", "tooLarge", "dbError", "conflict"] as const) {
    test(`${kind}: ${failure} preserves all existing objects`, async () => {
      const f = fixture(kind, { [failure]: true });
      const before = new Map(f.objects);
      const response = await f.run(failure === "invalid", failure === "malformed");
      assert.equal(response.status, failure === "tooLarge" ? 413 : failure === "conflict" ? 409 : failure === "dbError" || failure === "storageError" ? 500 : 400);
      assert.equal(f.published(), f.oldPath);
      for (const [key, bytes] of before) assert.equal(f.objects.get(key), bytes);
      if (failure !== "dbError") assert.deepEqual(f.objects, before);
    });
  }
  test(`${kind}: DB error after successful write retains potentially live bytes`, async () => {
    const f = fixture(kind, { dbError: true, hiddenSuccess: true });
    assert.equal((await f.run()).status, 500);
    assert.equal(f.objects.get(f.published()!), "new material");
    assert.equal(f.objects.get(f.oldPath!), "previous");
  });
  test(`${kind}: cleanup outage does not undo publication`, async () => {
    const f = fixture(kind, { cleanupError: true });
    assert.equal((await f.run()).status, 200);
    assert.equal(f.objects.get(f.published()!), "new material");
    assert.equal(f.objects.has(f.oldPath!), true);
  });
  test(`${kind}: concurrent requests use distinct keys and losing request cannot remove winner`, async () => {
    const f = fixture(kind, { concurrent: true });
    const responses = await Promise.all([f.run(), f.run()]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    assert.equal(new Set(f.writes).size, 2);
    assert.equal(f.objects.get(f.published()!), "new material");
    assert.equal(f.writes.filter(key => f.objects.has(key)).length, 1);
  });
}
