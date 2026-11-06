import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createLlmRateLimiter, createSharedRateLimitStore, LLM_RATE_LIMITS, type SharedRateLimitStore } from "./llm-rate-limit.ts";

const user = "11111111-1111-4111-8111-111111111111";
const otherUser = "22222222-2222-4222-8222-222222222222";

test("shared PostgreSQL counter: parallel instances, windows, isolation, grants and rollback", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      insert into auth.users values ('${user}'), ('${otherUser}');`);
    await db.exec(readFileSync(new URL("../../supabase/migrations/038_shared_llm_rate_limit.sql", import.meta.url), "utf8"));
    await db.exec("set role service_role");
    const store = (): SharedRateLimitStore => ({
      async consume(kind, userId, limit) {
        const result = await db.query<{ decision: { allowed: boolean; retry_after_seconds: number } }>(
          "select public.consume_llm_rate_limit($1::uuid, $2::text, $3::integer, $4::integer) as decision",
          [userId, kind, limit.windowMs, limit.maxRequests]);
        const d = result.rows[0].decision;
        return { allowed: d.allowed, retryAfterSeconds: d.retry_after_seconds };
      },
    });
    // Separate application limiters share only the database. PGlite serializes
    // connections; real PostgreSQL uses the unique key + FOR UPDATE lock.
    const instances = [createLlmRateLimiter(store()), createLlmRateLimiter(store())];
    for (const kind of Object.keys(LLM_RATE_LIMITS) as Array<keyof typeof LLM_RATE_LIMITS>) {
      const results = await Promise.all(Array.from({ length: 24 }, (_, i) => instances[i % 2](kind, user)));
      assert.equal(results.filter(r => r === null).length, LLM_RATE_LIMITS[kind].maxRequests);
      for (const r of results.filter(r => r !== null)) {
        assert.equal(r.status, 429);
        assert.ok(Number(r.headers.get("Retry-After")) >= 1);
      }
    }
    assert.equal(await instances[0]("ask", otherUser), null);
    // Expire exactly at the boundary without wall-clock sleeps.
    await db.exec(`update public.llm_rate_limit_buckets set timestamps = array[clock_timestamp() - interval '60 seconds'] where user_id = '${user}'`);
    assert.equal(await instances[1]("ask", user), null);
    const row = await db.query<{ n: number }>(`select cardinality(timestamps) n from public.llm_rate_limit_buckets where user_id = '${user}' and kind = 'ask'`);
    assert.equal(row.rows[0].n, 1);
    await db.exec("reset role");
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select public.consume_llm_rate_limit($1, 'ask', 60000, 6)", [user]), /permission denied/);
      await assert.rejects(db.exec("select * from public.llm_rate_limit_buckets"), /permission denied/);
      await db.exec("reset role");
    }
    await assert.rejects(db.query("select public.consume_llm_rate_limit($1, 'ask', 60000, 0)", [user]), /Invalid rate limit/);
    // A rolled-back admission must not consume quota.
    await db.exec("begin");
    await db.query("select public.consume_llm_rate_limit($1, 'ask', 60000, 6)", [user]);
    await db.exec("rollback");
    const after = await db.query<{ n: number }>(`select cardinality(timestamps) n from public.llm_rate_limit_buckets where user_id = '${user}' and kind = 'ask'`);
    assert.equal(after.rows[0].n, 1);
  } finally { await db.close(); }
});

for (const [name, consume] of [
  ["backend unavailable", async () => { throw new Error("secret database details"); }],
  ["invalid decision", async () => ({ allowed: false, retryAfterSeconds: NaN })],
] as const) {
  test(`${name}: fail closed with 503 and no backend details`, async () => {
    const limiter = createLlmRateLimiter({ consume });
    const res = await limiter("ask", user);
    assert.equal(res?.status, 503);
    assert.equal(res?.headers.get("Retry-After"), "5");
    assert.doesNotMatch(await res!.text(), /secret|database/);
  });
}

test("RPC adapter sends centralized limits and fails closed on errors, timeout and malformed results", async () => {
  for (const result of [
    { data: { allowed: true, retry_after_seconds: 0 }, error: null },
    { data: { allowed: false, retry_after_seconds: 42 }, error: null },
    { data: null, error: { message: "private backend error" } },
    { data: { allowed: "true", retry_after_seconds: 0 }, error: null },
    { data: { allowed: true, retry_after_seconds: -1 }, error: null },
    null,
  ]) {
    const store = createSharedRateLimitStore(async () => ({
      rpc(name, params) {
        assert.equal(name, "consume_llm_rate_limit");
        assert.deepEqual(params, { p_user_id: user, p_kind: "ask", p_window_ms: 60000, p_max_requests: 6 });
        return { async abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal);
          if (!result) throw new DOMException("timeout", "TimeoutError");
          return result;
        } };
      },
    }));
    const res = await createLlmRateLimiter(store)("ask", user);
    if (result?.data?.allowed === true && result.data.retry_after_seconds === 0) assert.equal(res, null);
    else if (result?.data?.allowed === false) {
      assert.equal(res?.status, 429);
      assert.equal(res?.headers.get("Retry-After"), "42");
    } else assert.equal(res?.status, 503);
  }
});
