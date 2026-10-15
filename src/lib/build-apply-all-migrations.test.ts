import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPLY_ALL_HEADER,
  getMigrationFiles,
  buildApplyAllSql,
  checkApplyAllSql,
} from "./build-apply-all-migrations.ts";

test("getMigrationFiles sorts migration files numerically", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-sort-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "002_second.sql"), "SELECT 2;");
    fs.writeFileSync(path.join(tmpDir, "010_tenth.sql"), "SELECT 10;");
    fs.writeFileSync(path.join(tmpDir, "001_first.sql"), "SELECT 1;");
    fs.writeFileSync(path.join(tmpDir, "README.txt"), "not sql");

    const files = getMigrationFiles(tmpDir);
    assert.deepEqual(files, ["001_first.sql", "002_second.sql", "010_tenth.sql"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildApplyAllSql produces header and sections in order", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-build-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "001_first.sql"), "CREATE TABLE t1 (id int);");
    fs.writeFileSync(path.join(tmpDir, "002_second.sql"), "ALTER TABLE t1 ADD col int;");

    const sql = buildApplyAllSql(tmpDir);
    assert.ok(sql.startsWith(APPLY_ALL_HEADER.trimEnd()));
    assert.ok(sql.includes("-- ----- 001_first.sql -----\n\nCREATE TABLE t1 (id int);"));
    assert.ok(sql.includes("-- ----- 002_second.sql -----\n\nALTER TABLE t1 ADD col int;"));
    assert.ok(sql.indexOf("001_first.sql") < sql.indexOf("002_second.sql"));
    assert.ok(sql.endsWith("\n"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("checkApplyAllSql correctly detects match and mismatch", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-check-test-"));
  try {
    const migDir = path.join(tmpDir, "migrations");
    fs.mkdirSync(migDir);
    fs.writeFileSync(path.join(migDir, "001_init.sql"), "SELECT 1;");

    const targetFile = path.join(tmpDir, "apply_all.sql");

    // Initially targetFile does not exist
    const res1 = checkApplyAllSql({ migrationsDir: migDir, targetFile });
    assert.equal(res1.ok, false);
    assert.equal(res1.current, null);

    // Write correct content
    fs.writeFileSync(targetFile, res1.generated, "utf-8");
    const res2 = checkApplyAllSql({ migrationsDir: migDir, targetFile });
    assert.equal(res2.ok, true);

    // Modify target content -> out of sync
    fs.writeFileSync(targetFile, res1.generated + "\n-- extra\n", "utf-8");
    const res3 = checkApplyAllSql({ migrationsDir: migDir, targetFile });
    assert.equal(res3.ok, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("actual repository migrations directory contains 001 through 031 with 016 before 017", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const migrationsDir = path.join(repoRoot, "supabase", "migrations");
  const files = getMigrationFiles(migrationsDir);

  assert.ok(files.length >= 31, `Expected at least 31 files, got ${files.length}`);
  assert.equal(files[0], "001_edu_share.sql");
  assert.ok(files.includes("016_notebooklm_slide_video.sql"));
  assert.ok(files.includes("017_notebooklm_material_files.sql"));
  assert.ok(files.includes("031_expose_failed_tests.sql"));

  const idx016 = files.indexOf("016_notebooklm_slide_video.sql");
  const idx017 = files.indexOf("017_notebooklm_material_files.sql");
  assert.ok(idx016 < idx017, "016 must precede 017");

  const sql = buildApplyAllSql(migrationsDir);
  assert.ok(sql.includes("-- ----- 016_notebooklm_slide_video.sql -----"));
  assert.ok(sql.includes("-- ----- 017_notebooklm_material_files.sql -----"));
  assert.ok(
    sql.indexOf("-- ----- 016_notebooklm_slide_video.sql -----") <
      sql.indexOf("-- ----- 017_notebooklm_material_files.sql -----")
  );
});
