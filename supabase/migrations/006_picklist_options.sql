-- プルダウン候補（学校名・科目・業界など）。認証ユーザーが追加・削除可能。

create table if not exists public.picklist_options (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  value text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  constraint picklist_options_category_check check (
    category in (
      'school_name',
      'expert_name',
      'exam_subject',
      'exam_period',
      'paper_industry',
      'publication_year'
    )
  ),
  constraint picklist_options_category_value_unique unique (category, value)
);

create index if not exists picklist_options_category_sort_idx
  on public.picklist_options (category, sort_order, value);

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
on conflict (category, value) do nothing;

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
on conflict (category, value) do nothing;

insert into public.picklist_options (category, value, sort_order) values
  ('exam_period', '前期中間', 10),
  ('exam_period', '前期期末', 20),
  ('exam_period', '後期中間', 30),
  ('exam_period', '後期期末', 40),
  ('exam_period', '学年末', 50),
  ('exam_period', '実力テスト・模試', 60),
  ('exam_period', 'その他', 9999)
on conflict (category, value) do nothing;

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
on conflict (category, value) do nothing;

insert into public.picklist_options (category, value, sort_order)
select
  'publication_year',
  y::text,
  3000 - y
from generate_series(1980, extract(year from now())::int + 1) as y
on conflict (category, value) do nothing;

insert into public.picklist_options (category, value, sort_order) values
  ('expert_name', '山田 太郎', 10),
  ('expert_name', 'Smith John', 20),
  ('expert_name', '佐藤 花子', 30),
  ('expert_name', 'その他', 9999)
on conflict (category, value) do nothing;

grant select on table public.picklist_options to anon, authenticated;
grant insert, delete on table public.picklist_options to authenticated;

notify pgrst, 'reload schema';
