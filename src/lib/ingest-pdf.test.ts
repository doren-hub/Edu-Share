import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

function load(path: string, stubs: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports: Record<string, any> = {};
  new Function("exports", "require", outputText)(exports, (name: string) => {
    assert.ok(Object.hasOwn(stubs, name), `Unexpected dependency: ${name}`);
    return stubs[name];
  });
  return exports;
}

function ingestion(options: { embeddingFailure?: boolean; rpcFailure?: boolean; empty?: boolean } = {}) {
  const events: string[] = [];
  let payload: any;
  const chunks = options.empty ? [] : Array.from({ length: 85 }, (_, i) => `chunk ${i}`);
  const { ingestPdfForTest } = load("./ingest-pdf.ts", {
    "@/lib/supabase/admin": { createAdminClient: () => ({
      rpc: async (name: string, args: unknown) => {
        events.push(name);
        payload = args;
        return { error: options.rpcFailure ? { message: "delete denied" } : null };
      },
      from: () => { throw new Error("Direct table writes forbidden"); },
    }) },
    "@/lib/object-storage": { getObjectBytes: async () => new Uint8Array() },
    "pdf-parse": { default: async () => ({ text: "body" }) },
    "@/lib/chunk-text": { chunkText: () => chunks },
    "@/lib/embeddings": {
      openAiEmbeddingsEnabled: () => true,
      embedTexts: async (part: string[]) => {
        events.push("embed");
        if (options.embeddingFailure) throw new Error("embedding unavailable");
        return part.map(() => [0.1]);
      },
    },
    "@/lib/pdf-text-by-page": {
      extractPdfTextByPage: async () => ["body"], guessPdfPageForChunk: () => 1,
    },
    "@/lib/sanitize-pdf-text": { sanitizeExtractedPdfText: (s: string) => s },
    "@/lib/strip-references-section": { stripReferencesSection: (s: string) => s },
  });
  return { run: () => ingestPdfForTest({ testId: "test", storagePath: "new.pdf", processingToken: "token" }), events, payload: () => payload };
}

test("embedding failure never reaches replacement; all batches precede one atomic RPC", async () => {
  const failing = ingestion({ embeddingFailure: true });
  await assert.rejects(failing.run(), /embedding unavailable/);
  assert.deepEqual(failing.events, ["embed"]);
  const success = ingestion();
  await success.run();
  assert.deepEqual(success.events, ["embed", "embed", "embed", "replace_test_pdf_chunks"]);
  assert.equal(success.payload().p_chunks.length, 85);
  assert.equal(success.payload().p_storage_path, "new.pdf");
  assert.equal(success.payload().p_processing_token, "token");
});

test("replacement error propagates without an insert retry; empty extraction retains notice", async () => {
  const failing = ingestion({ rpcFailure: true });
  await assert.rejects(failing.run(), /delete denied/);
  assert.equal(failing.events.filter(e => e === "replace_test_pdf_chunks").length, 1);
  const empty = ingestion({ empty: true });
  await empty.run();
  assert.deepEqual(empty.payload().p_chunks, []);
  assert.match(empty.payload().p_processing_error, /抽出できません/);
});

test("SQL replacement rolls back delete/insert errors and denies public invocation", async () => {
  const db = new PGlite();
  try {
    // Embedded PostgreSQL only; vector is represented by text in this fixture.
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table tests(id uuid primary key, pdf_storage_path text, processing_status text, processing_error text);
      create table document_chunks(test_id uuid references tests(id), chunk_index int, content text not null, pdf_page int, embedding text);
      insert into tests values ('11111111-1111-4111-8111-111111111111', 'old.pdf', 'pending', null);
      insert into document_chunks values ('11111111-1111-4111-8111-111111111111', 0, 'old', 1, null);
    `);
    const sql = readFileSync(new URL("../../supabase/migrations/037_atomic_pdf_chunks.sql", import.meta.url), "utf8");
    await db.exec(sql.replace("c.embedding::vector", "c.embedding::text"));
    const call = (rows: unknown[]) => db.query("select replace_test_pdf_chunks($1, $2, $3::jsonb, null)", [
      "11111111-1111-4111-8111-111111111111", "new.pdf", JSON.stringify(rows),
    ]);
    const assertOld = async () => {
      assert.deepEqual((await db.query("select content from document_chunks")).rows, [{ content: "old" }]);
      assert.equal((await db.query<any>("select pdf_storage_path from tests")).rows[0].pdf_storage_path, "old.pdf");
    };
    await assert.rejects(call([{ chunk_index: 0, content: "new" }, { chunk_index: 1, content: null }]));
    await assertOld();
    await db.exec(`
      create function deny_delete() returns trigger language plpgsql as $$ begin raise exception 'delete denied'; end $$;
      create trigger deny_delete before delete on document_chunks for each row execute function deny_delete();
      create function deny_insert() returns trigger language plpgsql as $$ begin raise exception 'insert attempted'; end $$;
      create trigger deny_insert before insert on document_chunks for each row execute function deny_insert();
    `);
    await assert.rejects(call([{ chunk_index: 0, content: "new" }]), /delete denied/);
    await assertOld();
    await db.exec("drop trigger deny_delete on document_chunks; drop trigger deny_insert on document_chunks;");
    await call([{ chunk_index: 0, content: "new", pdf_page: 2 }]);
    assert.deepEqual((await db.query("select content, pdf_page from document_chunks")).rows, [{ content: "new", pdf_page: 2 }]);
    assert.equal((await db.query<any>("select pdf_storage_path from tests")).rows[0].pdf_storage_path, "new.pdf");
    await assert.rejects(call([]), /not pending/);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(call([]), { code: "42501" });
      await db.exec("reset role");
    }
  } finally { await db.close(); }
});

const require = createRequire(import.meta.url);
const { NextResponse } = require("next/server.js");

test("concurrent replacement gets 409; failure preserves old PDF and releases pending state", async () => {
  let state = "ready";
  let path = "old.pdf";
  const uploads: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const uploading = new Promise<void>(resolve => { started = resolve; });
  const admin = { from: () => {
    let update: any;
    const chain: any = {
      select: () => chain, eq: () => chain, in: () => chain,
      update: (value: unknown) => { update = value; return chain; },
      single: async () => ({ data: { uploaded_by: "owner", pdf_storage_path: path } }),
      maybeSingle: async () => {
        if (state === "pending") return { data: null, error: null };
        state = "pending";
        return { data: { id: "test" }, error: null };
      },
      then: (resolve: (value: unknown) => void) => {
        state = update.processing_status;
        path = update.pdf_storage_path ?? path;
        resolve({ error: null });
      },
    };
    return chain;
  } };
  const { POST } = load("../app/api/tests/[id]/pdf/route.ts", {
    "node:crypto": { randomUUID: () => "unique" },
    "next/server": { NextResponse },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }) },
    "@/lib/supabase/admin": { createAdminClient: () => admin },
    "@/lib/object-storage": { putObject: async (key: string) => { uploads.push(key); started(); await wait; } },
    "@/lib/ingest-pdf": { ingestPdfForTest: async () => { throw new Error("embedding failed"); } },
    "@/lib/sanitize-processing-error": { sanitizeProcessingError: () => "safe error" },
  });
  const run = () => {
    const form = new FormData(); form.set("file", new File(["pdf"], "new.pdf", { type: "application/pdf" }));
    return POST(new Request("https://unused.invalid", { method: "POST", body: form }), { params: Promise.resolve({ id: "test" }) });
  };
  const first = run(); await uploading;
  assert.equal((await run()).status, 409);
  assert.deepEqual(uploads, ["owner/test-unique.pdf"]);
  release(); assert.equal((await first).status, 500);
  assert.equal(path, "old.pdf");
  assert.equal(state, "failed");
});

test("recovery fences stale success and failure, preserves PDF/chunks, audits and checks generation", async () => {
  const db = new PGlite();
  const id = "11111111-1111-4111-8111-111111111111";
  const oldToken = "22222222-2222-4222-8222-222222222222";
  const newToken = "33333333-3333-4333-8333-333333333333";
  const started = "2026-11-06T00:00:00.000Z";
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table tests(id uuid primary key, pdf_storage_path text, processing_status text, processing_error text);
      create table document_chunks(test_id uuid references tests(id), chunk_index int, content text not null, pdf_page int, embedding text);
      insert into tests values ('${id}', 'old.pdf', 'pending', null);
      insert into document_chunks values ('${id}', 0, 'old', 1, null);
    `);
    for (const file of ["037_atomic_pdf_chunks.sql", "041_pdf_processing_recovery.sql"]) {
      await db.exec(readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8")
        .replace("c.embedding::vector", "c.embedding::text"));
    }
    const recover = (token: string | null, time: string | null, confirmed = true, reason = "worker stopped: incident 226") =>
      db.query("select recover_test_pdf_processing($1,$2,$3,$4,$5,$6)", [id, token, time, "operator", reason, confirmed]);
    const finish = (token: string) => db.query("select replace_test_pdf_chunks($1,$2,$3,$4::jsonb,null)",
      [id, "new.pdf", token, JSON.stringify([{ chunk_index: 0, content: "new" }])]);
    const failure = (token: string) => db.query(`update tests set processing_status='failed', processing_error='delayed',
      pdf_processing_token=null, pdf_processing_started_at=null
      where id=$1 and processing_status='pending' and pdf_processing_token=$2 returning id`, [id, token]);
    const assertOld = async () => {
      assert.deepEqual((await db.query("select content from document_chunks")).rows, [{ content: "old" }]);
      assert.equal((await db.query<any>("select pdf_storage_path from tests")).rows[0].pdf_storage_path, "old.pdf");
    };
    // Legacy pending has no invented timestamp/token. Recovery still requires confirmation.
    await assert.rejects(recover(null, null, false), /confirmation/);
    await assert.rejects(recover(null, null, true, " "), /required/);
    await recover(null, null);
    await assertOld();
    await assert.rejects(db.query("select replace_test_pdf_chunks($1,'late.pdf','[]'::jsonb,null)", [id]), /does not exist/);
    await db.query("update tests set processing_status='pending', pdf_processing_token=$1, pdf_processing_started_at=$2", [oldToken, started]);
    await assert.rejects(recover(newToken, started), /generation changed/);
    await assert.rejects(recover(oldToken, "2026-11-05T00:00:00Z"), /generation changed/);
    await recover(oldToken, started);
    await assert.rejects(finish(oldToken), /not pending/);
    assert.deepEqual((await failure(oldToken)).rows, []);
    await assertOld();
    await db.query("update tests set processing_status='pending', pdf_processing_token=$1, pdf_processing_started_at=$2", [newToken, started]);
    await assert.rejects(recover(oldToken, started), /generation changed/);
    await assert.rejects(finish(oldToken), /not pending/);
    assert.deepEqual((await failure(oldToken)).rows, []);
    await assertOld();
    await finish(newToken);
    assert.deepEqual((await failure(oldToken)).rows, []);
    const row = (await db.query<any>("select * from tests")).rows[0];
    assert.equal(row.processing_status, "ready");
    assert.equal(row.pdf_processing_token, null);
    assert.equal(row.pdf_processing_started_at, null);
    assert.equal(row.pdf_storage_path, "new.pdf");
    assert.deepEqual((await db.query("select content from document_chunks")).rows, [{ content: "new" }]);
    assert.equal((await db.query<any>("select count(*)::int as n from pdf_processing_recoveries")).rows[0].n, 2);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(recover(newToken, started), { code: "42501" });
      await assert.rejects(finish(newToken), { code: "42501" });
      await assert.rejects(db.query("select * from pdf_processing_recoveries"), { code: "42501" });
      await db.exec("reset role");
    }
  } finally { await db.close(); }
});

for (const failAt of ["upload", "ingest"]) {
  test(`late replacement ${failAt} failure cannot overwrite a recovered/new generation`, async () => {
    const row: any = { id: "test", processing_status: "ready", pdf_storage_path: "old.pdf" };
    const admin = { from: () => {
      const filters: [string, unknown][] = [];
      let update: any;
      const apply = () => {
        if (filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value)) {
          Object.assign(row, update);
          return { data: { id: row.id }, error: null };
        }
        return { data: null, error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
        in: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
        update: (value: unknown) => { update = value; return chain; },
        single: async () => ({ data: { uploaded_by: "owner", pdf_storage_path: row.pdf_storage_path } }),
        maybeSingle: async () => apply(),
        then: (resolve: (v: unknown) => void) => resolve(apply()),
      };
      return chain;
    } };
    const lateFailure = async () => {
      assert.equal(row.pdf_processing_token, "old-token");
      assert.ok(row.pdf_processing_started_at);
      // Recovery fences old-token, then a new request claims this row.
      Object.assign(row, { processing_status: "pending", pdf_processing_token: "new-token", processing_error: null });
      throw new Error("old worker failed late");
    };
    const { POST } = load("../app/api/tests/[id]/pdf/route.ts", {
      "node:crypto": { randomUUID: () => "old-token" },
      "next/server": { NextResponse },
      "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }) },
      "@/lib/supabase/admin": { createAdminClient: () => admin },
      "@/lib/object-storage": { putObject: failAt === "upload" ? lateFailure : async () => {} },
      "@/lib/ingest-pdf": { ingestPdfForTest: async (params: any) => {
        assert.equal(params.processingToken, "old-token");
        await lateFailure();
      } },
      "@/lib/sanitize-processing-error": { sanitizeProcessingError: () => "safe error" },
    });
    const form = new FormData(); form.set("file", new File(["pdf"], "new.pdf", { type: "application/pdf" }));
    const response = await POST(new Request("https://unused.invalid", { method: "POST", body: form }), { params: Promise.resolve({ id: "test" }) });
    assert.equal(response.status, 500);
    assert.equal(row.processing_status, "pending");
    assert.equal(row.pdf_processing_token, "new-token");
    assert.equal(row.processing_error, null);
    assert.equal(row.pdf_storage_path, "old.pdf");
  });
}

for (const failAt of ["upload", "ingest"]) {
  test(`late initial ${failAt} failure cannot delete or fail the new generation`, async () => {
    const row: any = {};
    let affected = 0;
    const admin = { from: (table: string) => {
      const filters: [string, unknown][] = [];
      let update: any;
      const chain: any = {
        select: () => chain,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
        insert: (value: unknown) => { Object.assign(row, value); return chain; },
        update: (value: unknown) => { update = value; return chain; },
        delete: () => { update = { deleted: true }; return chain; },
        maybeSingle: async () => ({ data: { id: "owner" } }),
        single: async () => ({ data: { id: row.id } }),
        then: (resolve: (v: unknown) => void) => {
          assert.equal(table, "tests");
          if (filters.every(([key, value]) => row[key] === value)) {
            affected++; Object.assign(row, update);
          }
          resolve({ error: null });
        },
      };
      return chain;
    } };
    const lateFailure = async () => {
      assert.equal(row.pdf_processing_token, "old-token");
      assert.ok(row.pdf_processing_started_at);
      Object.assign(row, { processing_status: "pending", pdf_processing_token: "new-token" });
      throw new Error("late error");
    };
    const { POST } = load("../app/api/tests/upload/route.ts", {
      "node:crypto": { randomUUID: () => "old-token" },
      "next/server": { NextResponse },
      "@/lib/api-input-schemas": { uploadFormSchema: { safeParse: () => ({ success: true, data: { document_type: "past_exam", title: "test" } }) } },
      "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }) },
      "@/lib/supabase/admin": { createAdminClient: () => admin },
      "@/lib/object-storage": { putObject: failAt === "upload" ? lateFailure : async () => {} },
      "@/lib/ingest-pdf": { ingestPdfForTest: async (params: any) => {
        assert.equal(params.processingToken, "old-token"); await lateFailure();
      } },
      "@/lib/sanitize-processing-error": { sanitizeProcessingError: () => "safe error" },
      "@/lib/paper-authors": {}, "@/lib/paper-industries": {}, "@/lib/picklist-parse": {},
      "@/lib/picklist-merge": {}, "@/lib/supabase/picklist-table": {}, "@/lib/pdf-filename": {},
    });
    const form = new FormData(); form.set("file", new File(["pdf"], "new.pdf", { type: "application/pdf" }));
    const response = await POST(new Request("https://unused.invalid", { method: "POST", body: form }));
    assert.equal(response.status, 500);
    assert.equal(affected, 0);
    assert.equal(row.processing_status, "pending");
    assert.equal(row.pdf_processing_token, "new-token");
    assert.equal(row.deleted, undefined);
  });
}
