import fs from "node:fs";
import path from "node:path";
import {
  buildApplyAllSql,
  checkApplyAllSql,
  getMigrationFiles,
} from "../src/lib/build-apply-all-migrations.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");
const targetFile = path.join(repoRoot, "supabase", "apply_all_migrations.sql");

const isCheck = process.argv.includes("--check");

if (isCheck) {
  const result = checkApplyAllSql({ migrationsDir, targetFile });
  if (result.ok) {
    console.log("OK: supabase/apply_all_migrations.sql is up to date with migrations.");
    process.exit(0);
  } else {
    console.error(
      "ERROR: supabase/apply_all_migrations.sql is out of sync with supabase/migrations/.\n" +
        "Run `npm run db:build-apply-all` to regenerate it and commit the result."
    );
    process.exit(1);
  }
} else {
  const files = getMigrationFiles(migrationsDir);
  const sql = buildApplyAllSql(migrationsDir);
  fs.writeFileSync(targetFile, sql, "utf-8");
  console.log(
    `Built ${path.relative(repoRoot, targetFile)} from ${files.length} migration files (${files[0]} .. ${files[files.length - 1]}).`
  );
}
