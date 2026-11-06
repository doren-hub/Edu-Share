import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const id = "11111111-1111-4111-8111-111111111111";
const audit = "public.pdf_processing_recoveries";
const sequence = `${audit}_id_seq`;
const migration = (file: string) => readFileSync(
  new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8",
).replace("c.embedding::vector", "c.embedding::text");

for (const broadDefaults of [false, true]) {
  test(`PDF recovery audit is append-only for service_role (broad defaults: ${broadDefaults})`, async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create role anon; create role authenticated; create role service_role bypassrls;
        grant usage on schema public to anon, authenticated, service_role;
        ${broadDefaults ? `
          -- Model broad Supabase grants for the migration-owning role, including
          -- PUBLIC to ensure inherited privileges cannot undo the restriction.
          alter default privileges in schema public grant all on tables to public, anon, authenticated, service_role;
          alter default privileges in schema public grant all on sequences to public, anon, authenticated, service_role;
        ` : ""}
        create table tests(id uuid primary key, pdf_storage_path text, processing_status text, processing_error text);
        create table document_chunks(test_id uuid references tests(id), chunk_index int, content text not null, pdf_page int, embedding text);
        insert into tests values ('${id}', 'old.pdf', 'pending', null);
      `);
      await db.exec(migration("037_atomic_pdf_chunks.sql"));
      await db.exec(migration("041_pdf_processing_recovery.sql"));
      if (broadDefaults) {
        // Reproduce why an additive GRANT in 041 did not remove default ALL.
        assert.equal((await db.query<{ allowed: boolean }>(
          "select has_table_privilege('service_role', $1, 'UPDATE, DELETE, TRUNCATE') as allowed", [audit],
        )).rows[0].allowed, true);
      }
      // Existing databases get a new migration; applying it again is safe.
      await db.exec(migration("044_pdf_recovery_audit_acl.sql"));
      await db.exec(migration("044_pdf_recovery_audit_acl.sql"));
      await db.exec("grant select, update on tests to service_role");

      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const result = await db.query<{ allowed: boolean }>(
            "select has_table_privilege($1, $2, $3) as allowed", [role, audit, privilege],
          );
          assert.equal(result.rows[0].allowed, role === "service_role" && ["SELECT", "INSERT"].includes(privilege), `${role}: ${privilege}`);
        }
        for (const privilege of ["USAGE", "SELECT", "UPDATE"]) {
          const result = await db.query<{ allowed: boolean }>(
            "select has_sequence_privilege($1, $2, $3) as allowed", [role, sequence, privilege],
          );
          assert.equal(result.rows[0].allowed, role === "service_role" && privilege !== "UPDATE", `${role}: sequence ${privilege}`);
        }
      }

      await db.exec("set role service_role");
      // Exercise the actual invoker RPC with BYPASSRLS, not just as table owner.
      await db.query("select recover_test_pdf_processing($1,null,null,'operator','worker stopped',true)", [id]);
      await db.query(`insert into ${audit} (test_id, operator_name, reason) values ($1,'operator','manual audit')`, [id]);
      const expected = (await db.query(`select * from ${audit} order by id`)).rows;
      assert.equal(expected.length, 2);
      assert.deepEqual(expected.map((row: any) => row.reason), ["worker stopped", "manual audit"]);
      assert.equal((await db.query<{ processing_status: string }>("select processing_status from tests")).rows[0].processing_status, "failed");
      await db.exec("reset role");

      for (const role of ["anon", "authenticated", "service_role"]) {
        await db.exec(`set role ${role}`);
        if (role !== "service_role") {
          await assert.rejects(db.query(`select * from ${audit}`), { code: "42501" });
          await assert.rejects(db.query(`insert into ${audit} (test_id, operator_name, reason) values ($1,'intruder','forged')`, [id]), { code: "42501" });
          await assert.rejects(db.query("select nextval($1::regclass)", [sequence]), { code: "42501" });
        }
        for (const sql of [
          `update ${audit} set reason='tampered'`,
          `delete from ${audit}`,
          `truncate ${audit}`,
        ]) {
          await assert.rejects(db.query(sql), { code: "42501" }, `${role}: ${sql}`);
        }
        await assert.rejects(db.query("select setval($1::regclass, 100)", [sequence]), { code: "42501" });
        await db.exec("reset role");
      }
      assert.deepEqual((await db.query(`select * from ${audit} order by id`)).rows, expected);
    } finally { await db.close(); }
  });
}
