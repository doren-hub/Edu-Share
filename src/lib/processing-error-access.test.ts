import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { testDetailSelectVariants } from "./test-detail-select.ts";
import { testBrowseColumns, testBrowsePaperListColumns } from "./test-browse-select.ts";

const migrations = new URL("../../supabase/migrations/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, migrations), "utf8");

test("DB column ACLs deny anon errors while preserving public rows and authenticated detail", async () => {
  // Embedded PostgreSQL only: no server, credentials, network or production data.
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.profiles (id uuid primary key);
      ${read("001_edu_share.sql").match(/create table if not exists public\.tests \([\s\S]*?\n\);/)![0]}
    `);
    // Use the real tests column declarations, without unrelated Supabase/auth/vector setup.
    for (const file of readdirSync(migrations).filter(name => /^0\d\d_.*\.sql$/.test(name)).sort()) {
      if (file.startsWith("001_") || file >= "035_") continue;
      for (const ddl of read(file).matchAll(/alter table public\.tests\b[^;]*;/g)) await db.exec(ddl[0]);
    }
    await db.exec(`
      alter table public.tests enable row level security;
      ${[...read("031_expose_failed_tests.sql").matchAll(/create policy[^;]*;/g)].map(m => m[0]).join("\n")}
      grant select on public.tests to anon, authenticated, service_role, public;
      grant select (processing_error) on public.tests to anon, public;
      grant insert on public.tests to anon;
      insert into public.tests (title, source_type, source_name, pdf_storage_path, processing_status, processing_error)
      values ('failed fixture', 'school', 'fixture', 'fixture.pdf', 'failed', 'private error'),
             ('ready fixture', 'school', 'fixture', 'fixture.pdf', 'ready', 'private notice'),
             ('pending fixture', 'school', 'fixture', 'fixture.pdf', 'pending', 'private pending');
    `);
    const migration = read("035_protect_processing_error.sql");
    await db.exec(migration);
    await db.exec(migration); // Safe to reapply; never rewrites rows.
    const privileges = await db.query<{ attname: string; allowed: boolean }>(`
      select attname, has_column_privilege('anon', 'public.tests', attname, 'SELECT') as allowed
      from pg_attribute where attrelid = 'public.tests'::regclass and attnum > 0 and not attisdropped
    `);
    for (const column of privileges.rows) {
      assert.equal(column.allowed, column.attname !== "processing_error", column.attname);
    }
    await db.exec("set role anon");
    for (const select of ["processing_error", "title,processing_status,processing_error", "*", "to_jsonb(t)"]) {
      await assert.rejects(db.query(`select ${select} from public.tests t where processing_status = 'failed'`),
        (error: { code?: string }) => error.code === "42501", select);
    }
    // The protected column also cannot be used for filtering or ordering as an oracle.
    await assert.rejects(db.query("select title from public.tests where processing_error is not null"), { code: "42501" });
    await assert.rejects(db.query("select title from public.tests order by processing_error"), { code: "42501" });
    for (const columns of [...testDetailSelectVariants(), testBrowseColumns()]) {
      const result = await db.query<Record<string, unknown>>(`select ${columns} from public.tests order by title`);
      assert.equal(result.rows.length, 2);
      assert.ok(result.rows.every(row => !Object.hasOwn(row, "processing_error")));
    }
    // PostgREST JSON aliases use SQL projection syntax in this direct-DB test.
    const paperColumns = testBrowsePaperListColumns().replace(/(n[qv]\d):([a-z_]+)->(\d)/g, "$2->$3 as $1");
    assert.equal((await db.query(`select ${paperColumns} from public.tests`)).rows.length, 2);
    assert.equal((await db.query<{ n: number }>("select count(id) as n from public.tests")).rows[0]!.n, 2);
    await db.exec("reset role; alter table public.tests add column future_private text; set role anon");
    await assert.rejects(db.query("select future_private from public.tests"), { code: "42501" });
    await db.exec("reset role; set role authenticated");
    for (const columns of testDetailSelectVariants(true)) {
      const result = await db.query<Record<string, unknown>>(`select ${columns} from public.tests order by title`);
      assert.deepEqual(result.rows.map(row => row.processing_error), ["private error", "private notice"]);
    }
    await db.exec("reset role; set role service_role");
    assert.equal((await db.query("select processing_error from public.tests")).rows.length, 3);
    await db.exec("reset role");
    assert.equal((await db.query<{ allowed: boolean }>("select has_table_privilege('anon', 'public.tests', 'INSERT') as allowed")).rows[0]!.allowed, true);
  } finally {
    await db.close();
  }
});
