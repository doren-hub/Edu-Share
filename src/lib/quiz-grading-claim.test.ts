import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const session = "33333333-3333-4333-8333-333333333333";
const testId = "44444444-4444-4444-8444-444444444444";
const token = "55555555-5555-4555-8555-555555555555";
const nextToken = "66666666-6666-4666-8666-666666666666";
const read = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");

test("040: 処理権の競合・失効・再取得・古い処理の拒否・原子的保存・権限", async () => {
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
      insert into quiz_sessions (id,user_id,test_id) values ('${session}','${owner}','${testId}');
    `);
    await db.exec(`
      alter table quiz_sessions enable row level security;
      grant usage on schema public to authenticated;
      grant select, update on quiz_sessions to authenticated;
      create policy quiz_select_own on quiz_sessions for select to authenticated using (true);
      create policy quiz_update_own on quiz_sessions for update to authenticated using (true);
    `);
    await db.exec(read("013_question_performance.sql"));
    await db.exec(read("039_atomic_quiz_submit.sql"));
    const migration = read("040_quiz_grading_claim.sql");
    await db.exec(migration);
    await db.exec(migration);
    const claim = async (t = token, user = owner) => (await db.query<{ ok: boolean }>(
      "select claim_quiz_grading($1,$2,$3) as ok", [session, user, t],
    )).rows[0].ok;
    const release = async (t = token, user = owner) => (await db.query<{ ok: boolean }>(
      "select release_quiz_grading($1,$2,$3) as ok", [session, user, t],
    )).rows[0].ok;
    const submit = async (t = token, user = owner) => (await db.query<{ ok: boolean }>(
      "select submit_quiz_with_performance($1::uuid,$2::uuid,'{}'::jsonb,1,2,3,'{}'::jsonb,$3::jsonb,$4::uuid) as ok",
      [session, user, JSON.stringify([
        { question_key: "q1", question_type: "multiple_choice", prompt_excerpt: "p", correct: true },
        { question_key: "q2", question_type: "essay", prompt_excerpt: "e", correct: false },
      ]), t],
    )).rows[0].ok;
    const snapshot = async () => ({
      session: (await db.query<{ grading_token: string | null; grading_expires_at: string | null }>("select * from quiz_sessions")).rows,
      stats: (await db.query<{ attempts: number }>("select * from question_performance order by question_key")).rows,
    });
    assert.equal(await claim(token, other), false);
    assert.equal(await submit(), false); // no claim
    // PGlite serializes the overlapping SQL calls; API test holds grading open.
    assert.deepEqual(await Promise.all([claim(), claim(nextToken)]), [true, false]);
    assert.equal(await claim(), false); // cannot extend even with same token
    assert.equal(await release(token, other), false);
    assert.equal(await release(nextToken), false);
    assert.equal(await release(), true);
    assert.equal(await claim(), true); // explicit failure recovery
    await db.exec("update quiz_sessions set grading_expires_at = clock_timestamp() - interval '1 second'");
    assert.equal(await submit(), false); // expired even before another claim
    assert.equal(await claim(nextToken), true); // process crash recovery
    const reclaimed = await snapshot();
    await db.exec("set role authenticated");
    assert.equal((await db.query("update quiz_sessions set grading_token = null, answers_json = '{}' returning id")).rows.length, 0);
    await db.exec("reset role");
    assert.equal(await release(), false);
    assert.equal(await submit(), false); // fencing
    assert.equal(await submit(nextToken, other), false);
    assert.deepEqual(await snapshot(), reclaimed);
    await db.exec(`create function fail_second_stat() returns trigger language plpgsql as $$
      begin if new.question_type = 'essay' then raise exception 'injected failure'; end if;
      return new; end; $$;
      create trigger fail_stat before insert on question_performance for each row execute function fail_second_stat();`);
    await assert.rejects(submit(nextToken), /injected failure/);
    assert.deepEqual(await snapshot(), reclaimed); // rollback includes lease clearing + first stat
    await db.exec("drop trigger fail_stat on question_performance");
    assert.equal(await submit(nextToken), true);
    const saved = await snapshot();
    assert.equal(saved.session[0].grading_token, null);
    assert.equal(saved.session[0].grading_expires_at, null);
    assert.equal(saved.stats.length, 2);
    assert.equal(saved.stats[0].attempts, 1);
    assert.equal(await submit(nextToken), false);
    assert.equal(await claim(), false);
    assert.equal(await release(nextToken), false);
    await db.exec(migration);
    assert.deepEqual(await snapshot(), saved); // existing scores and stats stay unchanged
    // Old tokenless overload must not bypass the lease.
    await assert.rejects(db.query("select submit_quiz_with_performance($1::uuid,$2::uuid,'{}'::jsonb,1,2,3,'{}'::jsonb,'[]'::jsonb)", [session, owner]), /does not exist/);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      for (const call of [claim, release, submit]) await assert.rejects(call(), /permission denied for function/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    assert.equal(await claim(), false);
    assert.equal(await release(), false);
    assert.equal(await submit(), false);
    await db.exec("reset role");
    assert.deepEqual(await snapshot(), saved);
  } finally {
    await db.close();
  }
});
