-- =============================================================================
-- 既存の picklist_options に「学校スコープ列」を足すだけ（008 と同内容）
-- =============================================================================
-- 使い方:
--   すでに picklist_options テーブルがあるが、次のエラーが出るとき:
--     column picklist_options.scope_school_name does not exist
--   Supabase → SQL Editor にこのファイルをすべて貼り付け → Run
--
-- 注意: 全文の sql_editor_picklist_options.sql は「テーブル未作成向け」です。
-- テーブルがある環境では、このファイルだけを実行してください（重複作成を避ける）。
-- =============================================================================

-- 学科名・科目・テストの時期を「学校名」でスコープできるようにする

alter table public.picklist_options
  add column if not exists scope_school_name text null;

comment on column public.picklist_options.scope_school_name is
  'department_name / exam_subject / exam_period のとき、当該学校（tests.source_name と同一の表記）専用。NULL は全校共通。';

alter table public.picklist_options
  drop constraint if exists picklist_options_category_value_unique;

create unique index if not exists picklist_options_global_cat_value
  on public.picklist_options (category, value)
  where scope_school_name is null;

create unique index if not exists picklist_options_scoped_cat_value_school
  on public.picklist_options (category, value, scope_school_name)
  where scope_school_name is not null;

create index if not exists picklist_options_cat_scope_sort_idx
  on public.picklist_options (category, scope_school_name, sort_order);

alter table public.picklist_options
  drop constraint if exists picklist_options_scope_allowed_chk;

alter table public.picklist_options
  add constraint picklist_options_scope_allowed_chk check (
    scope_school_name is null
    or category in ('exam_subject', 'exam_period', 'department_name')
  );

notify pgrst, 'reload schema';
