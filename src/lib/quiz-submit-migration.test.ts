import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildQuestionPerformanceAttempts } from "./question-performance.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const session = "33333333-3333-4333-8333-333333333333";
const testId = "44444444-4444-4444-8444-444444444444";
const read = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");

test("039: PostgreSQLで途中障害の全件rollback・回復・再送・所有者・権限を検証", async () => {
  // PostgreSQL WASM engine, in-memory only: no sockets, credentials or external DB.
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table profiles (id uuid primary key);
      create table tests (id uuid primary key);
      create table quiz_sessions (
        id uuid primary key, user_id uuid references profiles, test_id uuid references tests,
        answers_json jsonb, score_mc int, score_essay int, score_total int, feedback_json jsonb
      );
      insert into profiles values ('${owner}'), ('${other}');
      insert into tests values ('${testId}');
      insert into quiz_sessions (id, user_id, test_id) values ('${session}', '${owner}', '${testId}');
    `);
    await db.exec(read("013_question_performance.sql"));
    const migration = read("039_atomic_quiz_submit.sql");
    await db.exec(migration);
    await db.exec(migration); // rerunnable without touching existing data
    const questions = [
      { id: "q1", type: "multiple_choice" as const, prompt: "p", options: ["a", "b"], correctIndex: 0 },
      { id: "q2", type: "essay" as const, prompt: "essay", referenceAnswer: "reference" },
    ];
    const attempts = buildQuestionPerformanceAttempts({
      testId, questions, answers: { q1: 0, q2: "answer" }, feedback: { essays: [{ id: "q2", score: 5 }] },
    });
    assert.deepEqual(attempts.map(a => a.correct), [true, false]);
    const submit = async (user = owner, id = session, entries = attempts) => {
      const result = await db.query<{ saved: boolean }>(
        "select submit_quiz_with_performance($1::uuid,$2::uuid,$3::jsonb,1,5,6,$4::jsonb,$5::jsonb) as saved",
        [id, user, JSON.stringify({ q1: 0, q2: "answer" }), JSON.stringify({ essays: [{ id: "q2", score: 5 }] }), JSON.stringify(entries)],
      );
      return result.rows[0].saved;
    };
    const snapshot = async () => ({
      sessions: (await db.query<{ score_total: number | null }>("select * from quiz_sessions order by id")).rows,
      stats: (await db.query<{ attempts: number; correct_count: number }>("select * from question_performance order by question_key")).rows,
    });
    const initial = await snapshot();
    assert.equal(await submit(other), false);
    assert.deepEqual(await snapshot(), initial);
    // Fail the SECOND stat insert, after both the session update and first stat insert.
    await db.exec(`create function fail_second_stat() returns trigger language plpgsql as $$
      begin if new.question_type = 'essay' then raise exception 'injected statistics failure'; end if;
      return new; end; $$;
      create trigger fail_stat before insert on question_performance for each row execute function fail_second_stat();`);
    await assert.rejects(submit(), /injected statistics failure/);
    assert.deepEqual(await snapshot(), initial);
    await db.exec("drop trigger fail_stat on question_performance");
    // Calls overlap at the client; PGlite serializes execution. The conditional UPDATE
    // is the PostgreSQL row-lock boundary, not an application read/write sequence.
    assert.deepEqual(await Promise.all([submit(), submit()]), [true, false]);
    const saved = await snapshot();
    assert.deepEqual(saved.stats.map(r => [r.attempts, r.correct_count]).sort(), [[1, 0], [1, 1]]);
    assert.equal(saved.sessions[0].score_total, 6);
    assert.equal(await submit(), false); // committed response lost, client retries
    assert.deepEqual(await snapshot(), saved);
    // Existing counts accumulate once for another session, never reset by migration.
    const second = "55555555-5555-4555-8555-555555555555";
    await db.exec(`insert into quiz_sessions (id,user_id,test_id) values ('${second}','${owner}','${testId}')`);
    await db.exec(migration);
    assert.equal(await submit(owner, second), true);
    assert.deepEqual((await snapshot()).stats.map(r => [r.attempts, r.correct_count]).sort(), [[2, 0], [2, 2]]);
    const noTest = "66666666-6666-4666-8666-666666666666";
    await db.exec(`insert into quiz_sessions (id,user_id) values ('${noTest}','${owner}')`);
    assert.equal(await submit(owner, noTest, []), true);
    const final = await snapshot();
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(submit(), /permission denied for function/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    assert.equal(await submit(), false);
    await db.exec("reset role");
    assert.deepEqual(await snapshot(), final);
  } finally {
    await db.close();
  }
});
