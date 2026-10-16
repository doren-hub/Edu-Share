import fs from "node:fs";
import path from "node:path";

export const APPLY_ALL_HEADER = `-- =============================================================================
-- Edu Share: 全マイグレーションを一度に適用するファイル
--
-- このファイルは supabase/migrations/*.sql から自動生成されます。
-- 手作業で編集せず、npm run db:build-apply-all で再生成してください。
--
-- Supabase ダッシュボード → SQL Editor → New query → 本ファイルを貼り付け → Run
--
-- アップロードで「tests テーブルがありません」と出るときは、まだこのスクリプトを
-- 当てていない可能性が高いです。手順:
--   1) Database → Extensions で「vector」を有効化（推奨。スクリプト内でも create します）
--   2) 本ファイルをすべて Run（tests / document_chunks / profiles 等が作成される）
--   3) 完了後、ダッシュボードで PostgREST のスキーマ再読み込みを待つか、数十秒後にアプリを再読み込み
--
-- 補足: 「exam_period が schema cache に無い」だけ直したい場合は、次の2つを順に Run してもよいです。
--   supabase/sql_editor_tests_app_columns.sql
--   supabase/sql_editor_reload_postgrest_schema.sql
-- =============================================================================
`;

const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

export function getMigrationFiles(migrationsDir: string): string[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"));

  const seenPrefixes = new Map<string, string>();

  for (const file of files) {
    if (!MIGRATION_FILE_PATTERN.test(file)) {
      throw new Error(
        `Invalid migration filename '${file}': must match pattern NNN_<name>.sql (e.g. 001_edu_share.sql)`
      );
    }
    const prefix = file.slice(0, 3);
    if (seenPrefixes.has(prefix)) {
      throw new Error(
        `Duplicate migration number prefix '${prefix}': found in both '${seenPrefixes.get(
          prefix
        )}' and '${file}'`
      );
    }
    seenPrefixes.set(prefix, file);
  }

  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function buildApplyAllSql(migrationsDir: string): string {
  const files = getMigrationFiles(migrationsDir);
  const sections: string[] = [APPLY_ALL_HEADER.trimEnd()];

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const content = fs.readFileSync(fullPath, "utf-8").trim();
    sections.push(`-- ----- ${file} -----\n\n${content}`);
  }

  return sections.join("\n\n") + "\n";
}

export function checkApplyAllSql(options: {
  migrationsDir: string;
  targetFile: string;
}): { ok: boolean; generated: string; current: string | null } {
  const generated = buildApplyAllSql(options.migrationsDir);
  if (!fs.existsSync(options.targetFile)) {
    return { ok: false, generated, current: null };
  }
  const current = fs.readFileSync(options.targetFile, "utf-8");
  return {
    ok: generated === current,
    generated,
    current,
  };
}
