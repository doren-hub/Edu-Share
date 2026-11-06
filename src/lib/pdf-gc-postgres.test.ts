import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

// This suite never accepts a connection URL or uses existing PG environment.
// It creates its own cluster, Unix socket and database with TCP disabled.
let bindir: string | undefined;
try {
  bindir = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
  execFileSync(path.join(bindir, "initdb"), ["--version"], { stdio: "ignore" });
} catch { bindir = undefined; }

test("isolated PostgreSQL: shared writers, ingestion/GC races, blocking and release", {
  skip: !bindir && "Local PostgreSQL binaries unavailable; install PostgreSQL and rerun this suite",
  timeout: 60_000,
}, async () => {
  mkdirSync(".kurukuru/run", { recursive: true });
  const root = mkdtempSync(path.resolve(".kurukuru/run/pg-gc-"));
  const data = path.join(root, "data");
  const socket = path.join(root, "s");
  mkdirSync(socket);
  // No inherited PG service, host, password, options or config variables.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
  const bin = (name: string) => path.join(bindir!, name);
  const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", "55473", "-U", "gc_test", "postgres"];
  const sessions: ReturnType<typeof session>[] = [];
  function session(name: string) {
    const child = spawn(bin("psql"), args, {
      env: { ...env, PGAPPNAME: name, PGOPTIONS: "-c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000" },
      stdio: "pipe",
    });
    let output = "";
    let errors = "";
    let counter = 0;
    let pending: { marker: string; resolve: (s: string) => void; reject: (e: Error) => void } | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (pending && output.includes(pending.marker + "\n")) {
        const value = output.slice(0, output.indexOf(pending.marker)).trim();
        output = "";
        pending.resolve(value);
        pending = undefined;
      }
    });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", error => pending?.reject(error));
    child.on("exit", code => pending?.reject(new Error(`psql exited ${code}: ${errors}`)));
    return {
      child,
      query(sql: string) {
        assert.equal(pending, undefined, "one query at a time per connection");
        return new Promise<string>((resolve, reject) => {
          const marker = `DONE_${++counter}`;
          pending = { marker, resolve, reject };
          child.stdin.write(`${sql};\n\\echo ${marker}\n`);
        });
      },
    };
  }
  const connect = (name: string) => { const s = session(name); sessions.push(s); return s; };
  let started = false;
  try {
    execFileSync(bin("initdb"), ["-D", data, "-U", "gc_test", "-A", "trust", "--no-locale"], { env, stdio: "pipe" });
    execFileSync(bin("pg_ctl"), ["-D", data, "-l", path.join(root, "server.log"), "-o", `-k ${socket} -p 55473 -c listen_addresses='' -c fsync=off`, "-w", "start"], { env, stdio: "pipe" });
    started = true;
    const admin = connect("gc_admin");
    await admin.query(`create role anon; create role authenticated; create role service_role;
      create table tests(id integer primary key, pdf_storage_path text, processing_status text,
        pdf_processing_token uuid, notebooklm_slide_pdf_storage_path text, notebooklm_video_mp4_storage_path text)`);
    for (const file of ["042_pdf_object_gc.sql", "043_pdf_gc_shared_guard.sql", "043_pdf_gc_shared_guard.sql"]) {
      await admin.query(readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"));
    }
    await admin.query("insert into tests(id, processing_status) values(1,'ready'),(2,'ready')");
    const writer = connect("gc_writer");
    const other = connect("gc_other");
    const collector = connect("gc_collector");
    const run = "33333333-3333-4333-8333-333333333333";
    const begin = `select begin_pdf_gc('${run}','local test','isolated cluster only')`;
    async function blocked(name: string) {
      // Observe the actual lock wait, rather than assuming a scheduling delay.
      for (let i = 0; i < 200; i++) {
        if (await admin.query(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock'`) === "1") return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`${name} did not block on a PostgreSQL lock`);
    }
    // Different tests rows can stay uncommitted simultaneously.
    await writer.query("begin; update tests set processing_status='ready' where id=1");
    await other.query("begin; set local lock_timeout='1s'; update tests set processing_status='ready' where id=2");
    const start = collector.query(begin);
    await blocked("gc_collector");
    await writer.query("commit");
    await blocked("gc_collector"); // still waits for the second shared writer
    await other.query("commit");
    await start;
    // A committed fence rejects publication until explicitly released.
    const rejected = connect("gc_rejected");
    await assert.rejects(rejected.query("update tests set pdf_storage_path='new.pdf' where id=2"), /maintenance active/);
    await admin.query(`select end_pdf_gc('${run}')`);
    // Ingestion that wins the lock race must commit before begin's drain check.
    await writer.query("begin; update tests set processing_status='pending' where id=1");
    const losingGc = connect("gc_losing_collector");
    const refused = assert.rejects(losingGc.query(begin), /ingestion still active/);
    await blocked("gc_losing_collector");
    await writer.query("commit");
    await refused;
    await admin.query("update tests set processing_status='ready' where id=1");
    const nextRun = "55555555-5555-4555-8555-555555555555";
    // GC wins the race: a writer blocks on the uncommitted fence then rejects.
    await collector.query(`begin; select begin_pdf_gc('${nextRun}','test','local')`);
    const late = connect("gc_late_writer");
    const lateFailure = assert.rejects(late.query("update tests set processing_status='pending' where id=1"), /maintenance active/);
    await blocked("gc_late_writer");
    await collector.query("commit");
    await lateFailure;
    await admin.query(`select end_pdf_gc('${nextRun}')`);
    await writer.query("update tests set processing_status='ready' where id=1");
    // An aborted GC transaction releases locks and never leaves a fence.
    await collector.query(`begin; select begin_pdf_gc('44444444-4444-4444-8444-444444444444','test','local')`);
    const waiting = writer.query("update tests set processing_status='ready' where id=1");
    await blocked("gc_writer");
    await collector.query("rollback");
    await waiting;
    assert.equal(await admin.query("select active_run is null from pdf_gc_guard"), "t");
  } finally {
    for (const s of sessions) s.child.stdin.end();
    await Promise.all(sessions.map(s => s.child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => s.child.once("exit", () => resolve()))));
    if (started) execFileSync(bin("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { env, stdio: "pipe" });
    rmSync(root, { recursive: true, force: true });
  }
});
