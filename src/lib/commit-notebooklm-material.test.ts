import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { reconcilePaperMaterialObjectPaths, type PaperMaterialStorageRow } from "./paper-notebooklm-storage.ts";
import { paperNotebookLmMaterialPresence } from "./paper-notebooklm-materials.ts";

const uploadId = "11111111-1111-4111-8111-111111111111";
function fixture(kind: "slide" | "video", options: {
  size?: number | null; type?: string | null; exists?: boolean; etag?: string | null;
  originalSize?: number; dbError?: boolean; conflict?: boolean; copyError?: boolean;
  cleanupError?: boolean; user?: string | null; oldPath?: string | null; deletion?: boolean;
} = {}) {
  const extension = kind === "slide" ? "pdf" : "mp4";
  const column = `notebooklm_${kind}_${extension}_storage_path`;
  const path = `owner/paper-notebooklm-${kind}-upload-${uploadId}.${extension}`;
  const oldPath = options.oldPath === undefined ? `owner/old.${extension}` : options.oldPath;
  const objects = new Map<string, string>([[path, "new bytes"], [oldPath ?? "unused", "old bytes"]]);
  const events: string[] = [];
  const signs: unknown[][] = [];
  let published = oldPath;
  let pending: Record<string, string>;
  const guards: unknown[][] = [];
  const query = {
    select: () => pending ? Promise.resolve({ data: options.conflict ? [] : [{ id: "paper" }], error: options.dbError ? { message: "unavailable" } : null }) : query,
    eq: (...args: unknown[]) => { guards.push(args); return query; },
    is: (...args: unknown[]) => { guards.push(args); return query; },
    single: async () => ({ data: { id: "paper", uploaded_by: "owner", pdf_storage_path: "original.pdf", [column]: oldPath }, error: null }),
    update: (data: Record<string, string>) => {
      events.push("db"); pending = data;
      if (!options.dbError && !options.conflict) published = data[column];
      return query;
    },
  };
  const stubs: Record<string, unknown> = {
    "node:crypto": { randomUUID: (() => { let n = 0; return () => `${++n}2222222-2222-4222-8222-222222222222`; })() },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: options.user === null ? null : { id: options.user ?? "owner" } } }) } }) },
    "@/lib/supabase/admin": { createAdminClient: () => ({ from: () => query }) },
    "@/lib/pdfs-bucket-upload": {},
    "@/lib/multipart-file-stream": {},
    "@/lib/test-notebooklm-material-paths": {
      notebooklmSlidePdfStoragePath: () => "fixed-slide.pdf",
      notebooklmVideoMp4StoragePath: () => "fixed-video.mp4",
      legacyNotebooklmSlidePdfStoragePath: () => "legacy-slide.pdf",
      legacyNotebooklmVideoMp4StoragePath: () => "legacy-video.mp4",
    },
    "@/lib/object-storage": {
      createObjectUploadUrl: async (...args: unknown[]) => { signs.push(args); return "https://upload.invalid"; },
      getObjectMetadata: async (key: string) => {
        events.push(`head:${key}`);
        return key === "original.pdf" ? { exists: true, size: options.originalSize ?? 1234 } : {
          exists: options.exists ?? true, size: options.size === undefined ? 30_000 : options.size,
          contentType: options.type === undefined ? (kind === "slide" ? "application/pdf" : "video/mp4") : options.type,
          etag: options.etag === undefined ? '"validated-etag"' : options.etag,
        };
      },
      copyObject: async (source: string, destination: string, etag: string, type: string) => {
        events.push("copy"); assert.equal(source, path); assert.equal(etag, '"validated-etag"');
        assert.equal(type, kind === "slide" ? "application/pdf" : "video/mp4");
        if (options.copyError) throw new Error("source changed");
        objects.set(destination, objects.get(source)!);
      },
      deleteObjects: async (keys: (string | null)[]) => {
        events.push("cleanup");
        if (options.cleanupError) throw new Error("delete unavailable");
        for (const key of keys) if (key) objects.delete(key);
      },
    },
  };
  const source = readFileSync(new URL(options.deletion ? `../app/api/tests/[id]/material/${kind}/route.ts` : "./commit-notebooklm-material.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, any> = {};
  new Function("exports", "require", outputText)(exports, (name: string) => {
    assert.ok(Object.hasOwn(stubs, name), `Unexpected dependency: ${name}`); return stubs[name];
  });
  return {
    path, oldPath, objects, events, signs, guards, published: () => published,
    run: (body: unknown = { action: "commit", path }) => {
      const req = new Request("https://app.invalid", { method: "POST", body: JSON.stringify(body) });
      const ctx = { params: Promise.resolve({ id: "paper" }) };
      return (options.deletion ? exports.DELETE(req, ctx) : exports.commitNotebooklmMaterial(kind, req, ctx)) as Promise<Response>;
    },
  };
}

for (const kind of ["slide", "video"] as const) {
  test(`${kind}: deletion cleans referenced immutable key only after DB success`, async () => {
    const success = fixture(kind, { deletion: true });
    assert.equal((await success.run()).status, 200);
    assert.equal(success.published(), null);
    assert.equal(success.objects.has(success.oldPath!), false);
    assert.deepEqual(success.events, ["db", "cleanup"]);
    const cleanupFailure = fixture(kind, { deletion: true, cleanupError: true });
    assert.equal((await cleanupFailure.run()).status, 200);
    assert.equal(cleanupFailure.published(), null);
    for (const failure of [{ dbError: true }, { conflict: true }]) {
      const f = fixture(kind, { deletion: true, ...failure });
      assert.equal((await f.run()).status, failure.dbError ? 500 : 409);
      assert.equal(f.objects.get(f.oldPath!), "old bytes");
      assert.deepEqual(f.events, ["db"]);
    }
  });

  test(`${kind}: prepare uses unique staging keys and signs exact length`, async () => {
    const f = fixture(kind);
    for (let i = 0; i < 2; i++) assert.equal((await f.run({ action: "prepare", size: 30_000 })).status, 200);
    assert.notEqual(f.signs[0][0], f.signs[1][0]);
    assert.match(String(f.signs[0][0]), /-upload-/);
    assert.equal(f.signs[0][3], 30_000);
    for (const size of [0, 1.5, 201 * 1024 * 1024]) assert.equal((await f.run({ action: "prepare", size })).status, 413);
    assert.equal(f.objects.get(f.oldPath!), "old bytes");
  });

  for (const invalid of [{ size: 1 }, { size: 201 * 1024 * 1024 }, { type: "text/plain" }, { exists: false }, { size: null }, { type: null }, { etag: null }]) {
    test(`${kind}: rejection preserves old material and deletes staging ${JSON.stringify(invalid)}`, async () => {
      const f = fixture(kind, invalid);
      assert.equal((await f.run()).status, 400);
      assert.equal(f.published(), f.oldPath);
      assert.equal(f.objects.get(f.oldPath!), "old bytes");
      assert.equal(f.objects.has(f.path), false);
      assert.ok(!f.events.includes("copy") && !f.events.includes("db"));
    });
  }

  test(`${kind}: publishes immutable copy before deleting old material; replay cannot overwrite live bytes`, async () => {
    const f = fixture(kind);
    const response = await f.run();
    assert.equal(response.status, 200);
    const { path } = await response.json();
    assert.equal(f.published(), path);
    assert.notEqual(path, f.path);
    assert.ok(!path.includes("-upload-"));
    assert.equal(f.objects.get(path), "new bytes");
    const column = kind === "slide" ? "notebooklm_slide_pdf_storage_path" : "notebooklm_video_mp4_storage_path";
    const input: PaperMaterialStorageRow = { id: "paper", uploaded_by: "owner", [column]: path };
    const [reconciled] = await reconcilePaperMaterialObjectPaths(
      { from: () => ({ update: () => { throw new Error("Published path must not change"); } }) },
      [input], async key => ({ exists: f.objects.has(key), size: f.objects.has(key) ? 30_000 : null, contentType: null }),
    );
    assert.deepEqual(reconciled, input);
    assert.equal(paperNotebookLmMaterialPresence(reconciled)[kind], true);
    assert.equal(f.objects.has(f.oldPath!), false);
    assert.equal(f.objects.has(f.path), false);
    assert.ok(f.events.indexOf("copy") < f.events.indexOf("db"));
    assert.ok(f.events.indexOf("db") < f.events.indexOf("cleanup"));
    assert.ok(f.guards.some(args => args[1] === f.oldPath));
    f.objects.set(f.path, "replayed invalid bytes");
    assert.equal(f.objects.get(path), "new bytes");
  });

  test(`${kind}: conditional copy failure cannot publish or remove old material`, async () => {
    const f = fixture(kind, { copyError: true });
    assert.equal((await f.run()).status, 500);
    assert.equal(f.objects.get(f.oldPath!), "old bytes");
    assert.equal(f.objects.has(f.path), false);
    assert.ok(!f.events.includes("db"));
  });

  test(`${kind}: concurrent conflict removes only losing copy; DB uncertainty retains potentially live copy`, async () => {
    for (const dbError of [false, true]) {
      const f = fixture(kind, { conflict: !dbError, dbError });
      assert.equal((await f.run()).status, dbError ? 500 : 409);
      assert.equal(f.objects.get(f.oldPath!), "old bytes");
      assert.equal(f.objects.has(f.path), false);
      assert.equal(f.objects.size, dbError ? 2 : 1);
    }
  });

  test(`${kind}: cleanup failure keeps successful publication`, async () => {
    const f = fixture(kind, { cleanupError: true, oldPath: null });
    assert.equal((await f.run()).status, 200);
    assert.equal(f.objects.get(f.published()!), "new bytes");
    assert.ok(f.guards.some(args => args[1] === null));
  });

  test(`${kind}: rejects foreign, live, malformed and missing keys without storage access`, async () => {
    const f = fixture(kind);
    for (const path of ["other/file.pdf", f.oldPath, f.path + "/suffix", undefined]) {
      assert.equal((await f.run({ action: "commit", path })).status, 400);
    }
    assert.deepEqual(f.events, []);
    for (const user of [null, "other"]) {
      const denied = fixture(kind, { user });
      assert.equal((await denied.run()).status, user === null ? 401 : 403);
      assert.deepEqual(denied.events, []);
    }
  });
}

test("slide: original PDF rejection removes staging without touching registered material", async () => {
  const f = fixture("slide", { originalSize: 30_000 });
  assert.equal((await f.run()).status, 400);
  assert.equal(f.objects.get(f.oldPath!), "old bytes");
  assert.equal(f.objects.has(f.path), false);
  assert.ok(!f.events.includes("copy") && !f.events.includes("db"));
});
