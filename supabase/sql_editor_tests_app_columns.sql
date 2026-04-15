-- =============================================================================
-- tests にアプリ用の列が足りないとき（exam_period など schema cache エラー用）
-- =============================================================================
-- 使い方:
--   アップロードで「Could not find the 'exam_period' column of 'tests'」等が出るが、
--   tests テーブル自体はある → 列が未追加の可能性があります。本スクリプトを Run 後、
--   sql_editor_reload_postgrest_schema.sql も実行し、**1分ほど待ってから**
--   アプリで「PDFアップロード」を開き、ファイルを選び直して**送信し直し**てください。
--
-- 列と CHECK を完全に揃える場合は supabase/apply_all_migrations.sql（002 以降）を推奨。
-- =============================================================================

alter table public.tests
  add column if not exists document_type text default 'past_exam';

alter table public.tests
  add column if not exists exam_subject text;

alter table public.tests
  add column if not exists exam_period text;

alter table public.tests
  add column if not exists industry text;

alter table public.tests
  add column if not exists publication_year text;

alter table public.tests
  add column if not exists exam_department text;

alter table public.tests
  add column if not exists paper_doi text;

alter table public.tests
  add column if not exists paper_venue text;

alter table public.tests
  add column if not exists paper_authors text[];

update public.tests
set document_type = 'past_exam'
where document_type is null;

notify pgrst, 'reload schema';
