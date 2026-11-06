import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { collectOrphanPdfs, GC_CANDIDATE, type GcDependencies, type GcObject } from "./pdf-object-gc.ts";
import { parseGcArguments } from "../../tools/gc-orphan-pdfs.ts";

const user = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const run = "33333333-3333-4333-8333-333333333333";
const nextRun = "44444444-4444-4444-8444-444444444444";
const key = `${user}/${id}.pdf`;
const old = new Date(Date.now() - 8 * 86400000).toISOString();
const obj: GcObject = { key, etag: '"etag"', lastModified: old, size: 42 };
const execute = { execute: true, writersStopped: true, operator: "test", approval: "owner-approved-test" };

function mock() {
  const calls: string[] = [];
  const events: Record<string, unknown>[] = [];
  const deps: GcDependencies = {
    async *list() { yield obj; },
    async head() { calls.push("head"); return obj; },
    async remove() { calls.push("delete"); },
    async rpc(name) { calls.push(name); return GC_CANDIDATE; },
    report(event) { events.push(event); },
  };
  return { deps, calls, events };
}
test("GC defaults to read-only dry-run with reasons, metadata and no fence/delete", async () => {
  const { deps, calls, events } = mock();
  assert.equal((await collectOrphanPdfs(deps)).deleted, 0);
  assert.deepEqual(calls, ["pdf_gc_reason"]);
  assert.equal(events[0].action, "would-delete");
  assert.equal(events[0].lastModified, old);
  assert.equal(events[0].reason, GC_CANDIDATE);
});
test("GC validates approval before any I/O; CLI rejects typos and contradictory flags", async () => {
  const { deps, calls } = mock();
  for (const options of [{ execute: true }, { ...execute, writersStopped: false }, { ...execute, approval: " " }]) {
    await assert.rejects(collectOrphanPdfs(deps, options), /requires/);
  }
  assert.deepEqual(calls, []);
  assert.equal(parseGcArguments([]).execute, false);
  assert.throws(() => parseGcArguments(["--exectue"]), /Unknown/);
  assert.throws(() => parseGcArguments(["--execute"]), /requires/);
  assert.throws(() => parseGcArguments(["--operator", "--execute"]), /Missing/);
  assert.throws(() => parseGcArguments(["--dry-run", "--execute"]), /Conflicting/);
});
test("GC fails closed for incomplete or changed objects and reference rechecks", async () => {
  for (const changed of [null, { ...obj, etag: '"new"' }, { ...obj, lastModified: new Date().toISOString() }, { ...obj, size: 99 }]) {
    const { deps, calls } = mock();
    deps.head = async () => changed;
    assert.equal((await collectOrphanPdfs(deps, execute)).deleted, 0);
    assert.ok(!calls.includes("delete"));
    assert.equal(calls.at(-1), "end_pdf_gc");
  }
  const { deps, calls } = mock();
  deps.list = async function* () { yield { ...obj, lastModified: "invalid" }; yield { ...obj, etag: "" }; };
  await collectOrphanPdfs(deps, execute);
  assert.deepEqual(calls, ["begin_pdf_gc", "end_pdf_gc"]);
});
test("GC records failure, releases fence, and safely retries; failed begin never releases another run", async () => {
  const { deps, calls } = mock();
  deps.remove = async () => { calls.push("delete-failed"); throw new Error("R2 failure"); };
  await assert.rejects(collectOrphanPdfs(deps, execute), /R2 failure/);
  assert.deepEqual(calls, ["begin_pdf_gc", "pdf_gc_reason", "head", "reserve_pdf_gc_object", "delete-failed", "finish_pdf_gc_object", "end_pdf_gc"]);
  deps.remove = async () => { calls.push("delete"); };
  assert.equal((await collectOrphanPdfs(deps, execute)).deleted, 1);
  deps.rpc = async (name) => { calls.push(name); throw new Error("busy"); };
  calls.length = 0;
  await assert.rejects(collectOrphanPdfs(deps, execute), /busy/);
  assert.deepEqual(calls, ["begin_pdf_gc"]);
});

test("042 SQL + mocked R2: references, active uploads, fence, tombstones, delete failure/retry and deleted tests", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      grant usage on schema public to anon, authenticated, service_role;
      create table tests(id uuid primary key, pdf_storage_path text, processing_status text,
        pdf_processing_token uuid, notebooklm_slide_pdf_storage_path text, notebooklm_video_mp4_storage_path text);
      grant select,insert,update,delete on tests to service_role;
    `);
    const migration = readFileSync(new URL("../../supabase/migrations/042_pdf_object_gc.sql", import.meta.url), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    const sqlRpc: GcDependencies["rpc"] = async (name, args) => {
      const params = Object.values(args);
      const placeholders = params.map((_, i) => `$${i + 1}`).join(",");
      return (await db.query<{ result: unknown }>(`select ${name}(${placeholders}) as result`, params)).rows[0].result;
    };
    const reason = (k = key, modified = old) => sqlRpc("pdf_gc_reason", { p_key: k, p_modified: modified });
    const begin = (r = run) => sqlRpc("begin_pdf_gc", { p_run: r, p_operator: "test", p_approval: "approved" });
    const end = (r = run) => sqlRpc("end_pdf_gc", { p_run: r });
    assert.equal(await reason(), GC_CANDIDATE);
    assert.equal(await reason(`${user}/notebooklm/slide.pdf`), "outside-source-pdf-namespace");
    assert.equal(await reason(key, new Date().toISOString()), "within-seven-day-grace");
    await db.query("insert into tests(id,pdf_storage_path,processing_status) values($1,$2,'ready')", [id, key]);
    assert.equal(await reason(), "referenced");
    await db.query("update tests set pdf_storage_path=null, notebooklm_slide_pdf_storage_path=$1", [key]);
    assert.equal(await reason(), "referenced"); // protect references in every storage column
    await db.exec("update tests set notebooklm_slide_pdf_storage_path=null, processing_status='pending'");
    assert.equal(await reason(), "ingestion-active");
    await assert.rejects(begin(), /ingestion still active/);
    await db.exec("update tests set processing_status='failed'");
    await begin();
    await assert.rejects(begin(nextRun), /guard unavailable/);
    await assert.rejects(db.exec("update tests set processing_status='pending'"), /maintenance active/);
    await assert.rejects(db.exec("delete from tests"), /maintenance active/);
    await assert.rejects(db.query("insert into tests(id) values($1)", [nextRun]), /maintenance active/);
    await assert.rejects(end(nextRun), /run mismatch/);
    await assert.rejects(sqlRpc("reserve_pdf_gc_object", { p_run: nextRun, p_key: key, p_modified: old, p_etag: obj.etag }), /run mismatch/);
    await end();
    const { deps, events } = mock();
    deps.rpc = sqlRpc;
    let present = true;
    deps.head = async () => present ? obj : null;
    let failDelete = true;
    deps.remove = async () => {
      // Attempt a concurrent replacement/publication during actual deletion.
      await assert.rejects(db.query("insert into tests(id,pdf_storage_path) values($1,$2)", [nextRun, key]), /maintenance active/);
      if (failDelete) throw new Error("injected R2 failure");
      present = false;
    };
    await assert.rejects(collectOrphanPdfs(deps, execute), /injected R2 failure/);
    assert.equal((await db.query<{ status: string }>("select status from pdf_gc_objects")).rows[0].status, "failed");
    await assert.rejects(db.query("update tests set pdf_storage_path=$1", [key]), /key retired/);
    // Storage consumers trim paths; whitespace cannot bypass retirement in any column.
    for (const column of ["pdf_storage_path", "notebooklm_slide_pdf_storage_path", "notebooklm_video_mp4_storage_path"]) {
      await assert.rejects(db.query(`update tests set ${column}=$1`, [`  ${key}  `]), /key retired/);
    }
    failDelete = false;
    assert.equal((await collectOrphanPdfs(deps, execute)).deleted, 1);
    assert.equal((await db.query<{ status: string }>("select status from pdf_gc_objects")).rows[0].status, "deleted");
    assert.equal(present, false);
    assert.ok(events.some(e => e.action === "deleted"));
    // A deleted test leaves a replacement object behind. Discovery does not
    // depend on the test row still existing or an FK to tests.
    await db.exec("delete from tests");
    present = true;
    assert.equal((await collectOrphanPdfs(deps, execute)).deleted, 1);
    // Permanent tombstones survive successful deletion, retries and migration rerun.
    await db.exec(migration);
    await assert.rejects(db.query("insert into tests(id,pdf_storage_path) values($1,$2)", [id, key]), /key retired/);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(begin(), /permission denied/);
      await assert.rejects(reason(), /permission denied/);
      await assert.rejects(db.exec("select * from pdf_gc_objects"), /permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    await begin(nextRun);
    await end(nextRun);
    await assert.rejects(db.exec("update pdf_gc_guard set active_run=null"), /permission denied/);
    await db.exec("reset role");
  } finally { await db.close(); }
});
