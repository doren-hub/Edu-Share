import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildQuestionPerformanceAttempts } from "./question-performance.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const session = "33333333-3333-4333-8333-333333333333";
const testId = "44444444-4444-4444-8444-444444444444";
const token = "55555555-5555-4555-8555-555555555555";
const read = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");

test("045: session/payload integrity, duplicate occurrences, rollback and existing data protection", async () => {
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
        questions_json jsonb not null, answers_json jsonb,
        score_mc int, score_essay int, score_total int, feedback_json jsonb
      );
      insert into profiles values ('${owner}'), ('${other}');
      insert into tests values ('${testId}');
    `);
    for (const name of ["013_question_performance.sql", "039_atomic_quiz_submit.sql", "040_quiz_grading_claim.sql", "045_quiz_attempt_integrity.sql"]) await db.exec(read(name));
    const questions = [
      { id: "q1", type: "multiple_choice" as const, prompt: "\uFEFF 問題 😀\u3000", options: ["\tはい\u00a0", "いいえ"], correctIndex: 0 },
      { id: "q2", type: "essay" as const, prompt: "Essay", referenceAnswer: "\u2003答え\n" },
      { id: "q3", type: "multiple_choice" as const, prompt: "\uFEFF 問題 😀\u3000", options: ["\tはい\u00a0", "いいえ"], correctIndex: 0 },
    ];
    const attempts = buildQuestionPerformanceAttempts({ testId, questions, answers: { q1: 0, q2: "答え", q3: 1 }, feedback: { essays: [{ id: "q2", score: 8 }] } });
    const reset = async (qs = questions, tid: string | null = testId) => {
      await db.query("delete from quiz_sessions where id=$1", [session]);
      await db.query("insert into quiz_sessions(id,user_id,test_id,questions_json) values ($1,$2,$3,$4::jsonb)", [session, owner, tid, JSON.stringify(qs)]);
      await db.query("select claim_quiz_grading($1,$2,$3)", [session, owner, token]);
    };
    const submit = async (entries: unknown = attempts, user = owner, t = token) => (await db.query<{ ok: boolean }>(
      "select submit_quiz_with_performance($1,$2,'{}'::jsonb,1,8,9,'{}'::jsonb,$3::jsonb,$4) as ok",
      [session, user, entries === undefined ? null : JSON.stringify(entries), t],
    )).rows[0].ok;
    const snapshot = async () => ({
      sessions: (await db.query("select * from quiz_sessions order by id")).rows,
      stats: (await db.query<{ attempts: number; correct_count: number }>("select * from question_performance order by question_key")).rows,
    });
    await reset();
    assert.equal(await submit(), true);
    const saved = await snapshot();
    assert.deepEqual(saved.stats.map(r => [r.attempts, r.correct_count]).sort(), [[1, 1], [2, 1]]);
    assert.equal(await submit([]), false); // submitted results immutable even with bad payload
    await db.exec(read("045_quiz_attempt_integrity.sql"));
    assert.deepEqual(await snapshot(), saved);
    await reset(); // retain existing counters
    const before = await snapshot();
    const invalid: unknown[] = [null, {}, [], attempts.slice(1), [...attempts, attempts[0]],
      [attempts[1], attempts[0], attempts[2]],
      attempts.map((a, i) => i === 1 ? { ...a, question_key: "foreign" } : a),
      attempts.map((a, i) => i === 1 ? { ...a, question_type: "multiple_choice" } : a),
      attempts.map((a, i) => i === 1 ? { ...a, correct: "true" } : a),
      attempts.map((a, i) => i === 1 ? { ...a, correct: null } : a),
      attempts.map((a, i) => i === 1 ? { question_key: a.question_key } : a),
      attempts.map((a, i) => i === 1 ? { ...a, prompt_excerpt: null } : a),
    ];
    for (const entries of invalid) {
      await assert.rejects(submit(entries), /attempts must|attempt does not match/);
      assert.deepEqual(await snapshot(), before);
    }
    await assert.rejects(db.query("select submit_quiz_with_performance($1,$2,'{}'::jsonb,1,8,9,'{}'::jsonb,null,$3)", [session, owner, token]), /attempts must/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await submit(attempts, other), false);
    assert.equal(await submit(attempts, owner, other), false);
    assert.deepEqual(await snapshot(), before);
    // Simulate relation changing after API read: same number/type but foreign keys.
    const changedTest = "66666666-6666-4666-8666-666666666666";
    await db.query("insert into tests values ($1)", [changedTest]);
    await db.query("update quiz_sessions set test_id=$1 where id=$2", [changedTest, session]);
    const changed = await snapshot();
    await assert.rejects(submit(), /attempt does not match/);
    assert.deepEqual(await snapshot(), changed);
    await reset();
    const claimed = await snapshot();
    await db.exec(`create function fail_essay() returns trigger language plpgsql as $$
      begin if new.question_type='essay' then raise exception 'injected failure'; end if; return new; end; $$;
      create trigger fail_stat before insert on question_performance for each row execute function fail_essay();`);
    await assert.rejects(submit(), /injected failure/);
    assert.deepEqual(await snapshot(), claimed);
    await db.exec("drop trigger fail_stat on question_performance");
    assert.equal(await submit(), true);
    assert.deepEqual((await snapshot()).stats.map(r => [r.attempts, r.correct_count]).sort(), [[2, 2], [4, 2]]);
    await reset([]);
    const stats = (await snapshot()).stats;
    await assert.rejects(submit(attempts), /cover every/);
    assert.equal(await submit([]), true);
    assert.deepEqual((await snapshot()).stats, stats);
    await reset(questions, null);
    assert.equal(await submit(null), true); // no test: ignored stats, legacy behavior
    assert.deepEqual((await snapshot()).stats, stats);
    await reset();
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(submit(), /permission denied for function/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    assert.equal(await submit(), true);
    await db.exec("reset role");
  } finally { await db.close(); }
});
