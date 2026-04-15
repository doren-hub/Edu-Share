-- =============================================================================
-- picklist_options の作成・初期データ・権限（SQL Editor 用ワンスクリプト）
-- =============================================================================
-- 使い方:
--   1. Supabase ダッシュボード → SQL Editor → New query
--   2. このファイルの内容をすべて貼り付け → Run
--   3. 数秒待ってからアプリを再読み込み（候補プルダウンが表示される）
--
-- すでに picklist_options があるが「scope_school_name がない」エラーのときは、
-- このファイルではなく sql_editor_picklist_scope_only.sql を実行してください。
--
-- 学科名は学校別、科目・テストの時期は学校＋学科別の候補を持てます（NULL=共通）。
-- =============================================================================

-- プルダウン候補（学校名・科目・業界など）。認証ユーザーが追加・削除可能。

create table if not exists public.picklist_options (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  value text not null,
  sort_order int not null default 0,
  scope_school_name text null,
  scope_department_value text null,
  created_at timestamptz not null default now(),
  constraint picklist_options_category_check check (
    category in (
      'school_name',
      'department_name',
      'expert_name',
      'exam_subject',
      'exam_period',
      'paper_industry',
      'publication_year'
    )
  ),
  constraint picklist_options_scope_allowed_chk check (
    scope_school_name is null
    or category in ('exam_subject', 'exam_period', 'department_name')
  )
);

alter table public.picklist_options
  add column if not exists scope_department_value text null;

comment on column public.picklist_options.scope_department_value is
  'exam_subject / exam_period のみ。学校内の学科専用。NULL は全校または学校内全学科共通。';

alter table public.picklist_options
  drop constraint if exists picklist_options_dept_scope_chk;

alter table public.picklist_options
  add constraint picklist_options_dept_scope_chk check (
    scope_department_value is null
    or (
      category in ('exam_subject', 'exam_period')
      and scope_school_name is not null
      and btrim(scope_department_value) <> ''
    )
  );

drop index if exists picklist_options_global_cat_value;
drop index if exists picklist_options_scoped_cat_value_school;

create unique index if not exists picklist_options_global_cat_value
  on public.picklist_options (category, value)
  where scope_school_name is null
    and (scope_department_value is null or btrim(scope_department_value) = '');

create unique index if not exists picklist_options_scoped_school_only_cat_value
  on public.picklist_options (category, value, scope_school_name)
  where scope_school_name is not null
    and (scope_department_value is null or btrim(scope_department_value) = '');

create unique index if not exists picklist_options_scoped_school_dept_cat_value
  on public.picklist_options (category, value, scope_school_name, scope_department_value)
  where scope_school_name is not null
    and scope_department_value is not null
    and btrim(scope_department_value) <> '';

create index if not exists picklist_options_category_sort_idx
  on public.picklist_options (category, sort_order, value);

create index if not exists picklist_options_cat_scope_sort_idx
  on public.picklist_options (category, scope_school_name, sort_order);

alter table public.picklist_options enable row level security;

drop policy if exists "picklist_options_select_all" on public.picklist_options;
create policy "picklist_options_select_all"
  on public.picklist_options for select
  using (true);

drop policy if exists "picklist_options_insert_authenticated" on public.picklist_options;
create policy "picklist_options_insert_authenticated"
  on public.picklist_options for insert
  to authenticated
  with check (true);

drop policy if exists "picklist_options_delete_authenticated" on public.picklist_options;
create policy "picklist_options_delete_authenticated"
  on public.picklist_options for delete
  to authenticated
  using (true);

-- ----- 初期データ -----

insert into public.picklist_options (category, value, sort_order) values
  ('school_name', '○○高等学校', 10),
  ('school_name', '△△中学校', 20),
  ('school_name', '□□高等学校', 30),
  ('school_name', 'サンプル高等学校', 40),
  ('school_name', 'デモ中学校', 50),
  ('school_name', 'その他', 9999)
on conflict (category, value) where (
    scope_school_name is null
    and (scope_department_value is null or btrim(scope_department_value) = '')
  ) do nothing;

insert into public.picklist_options (category, value, sort_order) values
  ('department_name', '普通科', 10),
  ('department_name', '理数科', 20),
  ('department_name', '総合学科', 30),
  ('department_name', '体育・芸術科', 40),
  ('department_name', '国際科', 50),
  ('department_name', '探求科', 60),
  ('department_name', 'その他', 9999)
on conflict (category, value) where (
    scope_school_name is null
    and (scope_department_value is null or btrim(scope_department_value) = '')
  ) do nothing;

insert into public.picklist_options (category, value, sort_order) values
  ('exam_subject', '数学', 10),
  ('exam_subject', '国語', 20),
  ('exam_subject', '英語', 30),
  ('exam_subject', '理科', 40),
  ('exam_subject', '社会', 50),
  ('exam_subject', '物理', 60),
  ('exam_subject', '化学', 70),
  ('exam_subject', '生物', 80),
  ('exam_subject', '地学', 90),
  ('exam_subject', '地理総合', 100),
  ('exam_subject', '歴史総合', 110),
  ('exam_subject', '公民', 120),
  ('exam_subject', '情報', 130),
  ('exam_subject', '美術', 140),
  ('exam_subject', '音楽', 150),
  ('exam_subject', '保健体育', 160),
  ('exam_subject', 'その他', 9999)
on conflict (category, value) where (
    scope_school_name is null
    and (scope_department_value is null or btrim(scope_department_value) = '')
  ) do nothing;

insert into public.picklist_options (category, value, sort_order) values
  ('exam_period', '前期中間', 10),
  ('exam_period', '前期期末', 20),
  ('exam_period', '後期中間', 30),
  ('exam_period', '後期期末', 40),
  ('exam_period', '学年末', 50),
  ('exam_period', '実力テスト・模試', 60),
  ('exam_period', 'その他', 9999)
on conflict (category, value) where (
    scope_school_name is null
    and (scope_department_value is null or btrim(scope_department_value) = '')
  ) do nothing;

insert into public.picklist_options (category, value, sort_order) values
  ('paper_industry', 'IT・通信', 10),
  ('paper_industry', '医療・ヘルスケア', 20),
  ('paper_industry', '金融・保険', 30),
  ('paper_industry', '教育・研究', 40),
  ('paper_industry', '製造業', 50),
  ('paper_industry', 'エネルギー・インフラ', 60),
  ('paper_industry', '小売・流通', 70),
  ('paper_industry', 'メディア・エンタメ', 80),
  ('paper_industry', '公共・非営利', 90),
  ('paper_industry', 'その他', 9999)
on conflict (category, value) where (
    scope_school_name is null
    and (scope_department_value is null or btrim(scope_department_value) = '')
  ) do nothing;

insert into public.picklist_options (category, value, sort_order)
select
  'publication_year',
  y::text,
  3000 - y
from generate_series(1980, extract(year from now())::int + 1) as y
on conflict (category, value) where (
  scope_school_name is null
  and (scope_department_value is null or btrim(scope_department_value) = '')
) do nothing;

insert into public.picklist_options (category, value, sort_order) values
  ('expert_name', '山田 太郎', 10),
  ('expert_name', 'Smith John', 20),
  ('expert_name', '佐藤 花子', 30),
  ('expert_name', 'その他', 9999)
on conflict (category, value) where (
    scope_school_name is null
    and (scope_department_value is null or btrim(scope_department_value) = '')
  ) do nothing;

grant select on table public.picklist_options to anon, authenticated;
grant insert, delete on table public.picklist_options to authenticated;

notify pgrst, 'reload schema';
