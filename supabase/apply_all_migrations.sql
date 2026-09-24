-- =============================================================================
-- Edu Share: 全マイグレーションを一度に適用するファイル
-- Supabase ダッシュボード → SQL Editor → New query → 本ファイルを貼り付け → Run
--
-- アップロードで「tests テーブルがありません」と出るときは、まだこのスクリプトを
-- 当てていない可能性が高いです。手順:
--   1) Database → Extensions で「vector」を有効化（推奨。スクリプト内でも create します）
--   2) 本ファイルをすべて Run（tests / document_chunks / profiles / storage 等が作成される）
--   3) 完了後、ダッシュボードで PostgREST のスキーマ再読み込みを待つか、数十秒後にアプリを再読み込み
--
-- 補足: 「exam_period が schema cache に無い」だけ直したい場合は、次の2つを順に Run してもよいです。
--   supabase/sql_editor_tests_app_columns.sql
--   supabase/sql_editor_reload_postgrest_schema.sql
-- =============================================================================

-- ----- 001_edu_share.sql -----

-- Edu Share: profiles, tests, RAG chunks, quiz sessions, storage policies
-- Run in Supabase SQL Editor or via CLI migrations.

create extension if not exists "uuid-ossp";
create extension if not exists vector;

do $$ begin
  create type public.user_role as enum (
    'school_student',
    'expert',
    'certification',
    'general'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  role public.user_role not null default 'general',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.user_role := 'general';
  role_text text := coalesce(new.raw_user_meta_data->>'role', '');
begin
  if role_text in ('school_student', 'expert', 'certification', 'general') then
    r := role_text::public.user_role;
  end if;

  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(coalesce(new.email, ''), '@', 1)),
    r
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create table if not exists public.tests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  pdf_storage_path text not null,
  source_type text not null check (source_type in ('school', 'expert')),
  source_name text not null,
  uploaded_by uuid references public.profiles (id) on delete set null,
  processing_status text not null default 'pending' check (processing_status in ('pending', 'ready', 'failed')),
  processing_error text,
  created_at timestamptz not null default now()
);

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests (id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536)
);

create index if not exists document_chunks_test_id_idx on public.document_chunks (test_id);

-- HNSW index (Supabase pgvector). Safe to create even with few rows.
create index if not exists document_chunks_embedding_hnsw
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

create table if not exists public.quiz_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  test_id uuid not null references public.tests (id) on delete cascade,
  questions_json jsonb not null,
  answers_json jsonb,
  score_mc int,
  score_essay int,
  score_total numeric,
  feedback_json jsonb,
  created_at timestamptz not null default now()
);

create index if not exists quiz_sessions_user_id_idx on public.quiz_sessions (user_id);
create index if not exists quiz_sessions_test_id_idx on public.quiz_sessions (test_id);

alter table public.profiles enable row level security;
alter table public.tests enable row level security;
alter table public.document_chunks enable row level security;
alter table public.quiz_sessions enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

drop policy if exists "tests_select_authenticated" on public.tests;
create policy "tests_select_authenticated"
  on public.tests for select
  to authenticated
  using (true);

drop policy if exists "tests_insert_authenticated" on public.tests;
create policy "tests_insert_authenticated"
  on public.tests for insert
  to authenticated
  with check (auth.uid() = uploaded_by);

drop policy if exists "chunks_select_authenticated_ready" on public.document_chunks;
create policy "chunks_select_authenticated_ready"
  on public.document_chunks for select
  to authenticated
  using (
    exists (
      select 1 from public.tests t
      where t.id = document_chunks.test_id
        and t.processing_status = 'ready'
    )
  );

drop policy if exists "quiz_select_own" on public.quiz_sessions;
create policy "quiz_select_own"
  on public.quiz_sessions for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "quiz_insert_own" on public.quiz_sessions;
create policy "quiz_insert_own"
  on public.quiz_sessions for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "quiz_update_own" on public.quiz_sessions;
create policy "quiz_update_own"
  on public.quiz_sessions for update
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "quiz_delete_own" on public.quiz_sessions;
create policy "quiz_delete_own"
  on public.quiz_sessions for delete
  to authenticated
  using (auth.uid() = user_id);

-- Storage bucket (create in Dashboard if insert fails)
insert into storage.buckets (id, name, public)
values ('pdfs', 'pdfs', false)
on conflict (id) do nothing;

drop policy if exists "pdfs_insert_own_prefix" on storage.objects;
create policy "pdfs_insert_own_prefix"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "pdfs_select_own_prefix" on storage.objects;
create policy "pdfs_select_own_prefix"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "pdfs_update_own_prefix" on storage.objects;
create policy "pdfs_update_own_prefix"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "pdfs_delete_own_prefix" on storage.objects;
create policy "pdfs_delete_own_prefix"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Service role bypasses RLS for server-side ingestion (use service key in Next.js API routes).

-- ----- 002_rag_and_public_read.sql -----

-- 公開テスト一覧（ready のみ）、ベクトル検索RPC、HNSWをNULL除外に

drop policy if exists "tests_select_authenticated" on public.tests;
create policy "tests_select_authenticated"
  on public.tests for select
  to authenticated
  using (processing_status = 'ready');

drop policy if exists "tests_select_anon" on public.tests;
create policy "tests_select_anon"
  on public.tests for select
  to anon
  using (processing_status = 'ready');

drop index if exists public.document_chunks_embedding_hnsw;
create index document_chunks_embedding_hnsw
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops)
  where (embedding is not null);

alter table public.tests
  add column if not exists document_type text
  default 'past_exam'
  check (document_type in ('past_exam', 'paper'));

create or replace function public.match_document_chunks (
  p_test_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 8
)
returns table (content text, similarity double precision)
language sql
stable
as $$
  select
    dc.content,
    (1 - (dc.embedding <=> p_query_embedding))::double precision as similarity
  from public.document_chunks dc
  where dc.test_id = p_test_id
    and dc.embedding is not null
  order by dc.embedding <=> p_query_embedding
  limit greatest(1, least(p_match_count, 32));
$$;

revoke all on function public.match_document_chunks (uuid, vector, int) from public;
grant execute on function public.match_document_chunks (uuid, vector, int) to service_role;

-- ----- 003_lockdown_chunk_reads.sql -----

-- チャンク本文はサーバー（service role）経由のみ参照させる（クライアント直読み防止）
drop policy if exists "chunks_select_authenticated_ready" on public.document_chunks;

-- ----- 004_past_exam_subject_period.sql -----

alter table public.tests
  add column if not exists exam_subject text,
  add column if not exists exam_period text;

-- ----- 005_paper_industry_year.sql -----

alter table public.tests
  add column if not exists industry text,
  add column if not exists publication_year text;

-- ----- 006_picklist_options.sql -----

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

-- ----- 007_picklist_options_grants.sql -----
grant select on table public.picklist_options to anon, authenticated;
grant insert, delete on table public.picklist_options to authenticated;

notify pgrst, 'reload schema';

-- ----- 008_picklist_scope_school.sql -----

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
    or category in ('exam_subject', 'exam_period')
  );

notify pgrst, 'reload schema';

-- ----- 009_exam_department_picklist.sql -----

alter table public.tests add column if not exists exam_department text;

comment on column public.tests.exam_department is
  '過去問の学科名（論文では未使用）。picklist_options.category = department_name と対応。';

alter table public.picklist_options drop constraint if exists picklist_options_category_check;

alter table public.picklist_options add constraint picklist_options_category_check check (
  category in (
    'school_name',
    'department_name',
    'expert_name',
    'exam_subject',
    'exam_period',
    'paper_industry',
    'publication_year'
  )
);

alter table public.picklist_options drop constraint if exists picklist_options_scope_allowed_chk;

alter table public.picklist_options add constraint picklist_options_scope_allowed_chk check (
  scope_school_name is null
  or category in ('exam_subject', 'exam_period', 'department_name')
);

-- 学科名シードは 011 の一意インデックス作成後に投入（ON CONFLICT と WHERE を一致させる）

notify pgrst, 'reload schema';

-- ----- 011_exam_subject_period_department_scope.sql -----

alter table public.picklist_options
  add column if not exists scope_department_value text null;

comment on column public.picklist_options.scope_department_value is
  'exam_subject / exam_period のみ。学校内の学科（tests.exam_department と同一の表記）専用。NULL は全校共通またはその学校の全学科共通。';

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
drop index if exists picklist_options_scoped_school_only_cat_value;
drop index if exists picklist_options_scoped_school_dept_cat_value;

create unique index picklist_options_global_cat_value
  on public.picklist_options (category, value)
  where scope_school_name is null
    and (scope_department_value is null or btrim(scope_department_value) = '');

create unique index picklist_options_scoped_school_only_cat_value
  on public.picklist_options (category, value, scope_school_name)
  where scope_school_name is not null
    and (scope_department_value is null or btrim(scope_department_value) = '');

create unique index picklist_options_scoped_school_dept_cat_value
  on public.picklist_options (category, value, scope_school_name, scope_department_value)
  where scope_school_name is not null
    and scope_department_value is not null
    and btrim(scope_department_value) <> '';

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

-- ----- 013_question_performance.sql -----

create table if not exists public.question_performance (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  test_id uuid not null references public.tests (id) on delete cascade,
  question_key text not null,
  prompt_excerpt text not null,
  question_type text not null check (question_type in ('multiple_choice', 'essay')),
  attempts int not null default 0 check (attempts >= 0),
  correct_count int not null default 0 check (correct_count >= 0 and correct_count <= attempts),
  updated_at timestamptz not null default now(),
  unique (user_id, test_id, question_key)
);

create index if not exists question_performance_user_test_idx
  on public.question_performance (user_id, test_id);

alter table public.question_performance enable row level security;

drop policy if exists "question_performance_select_own" on public.question_performance;
create policy "question_performance_select_own"
  on public.question_performance for select
  to authenticated
  using (auth.uid() = user_id);

grant select on table public.question_performance to authenticated;

create or replace function public.record_question_attempt(
  p_user_id uuid,
  p_test_id uuid,
  p_question_key text,
  p_prompt_excerpt text,
  p_question_type text,
  p_correct boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.question_performance (
    user_id,
    test_id,
    question_key,
    prompt_excerpt,
    question_type,
    attempts,
    correct_count
  )
  values (
    p_user_id,
    p_test_id,
    p_question_key,
    left(btrim(coalesce(p_prompt_excerpt, '')), 200),
    p_question_type,
    1,
    case when p_correct then 1 else 0 end
  )
  on conflict (user_id, test_id, question_key) do update set
    attempts = public.question_performance.attempts + 1,
    correct_count = public.question_performance.correct_count
      + (case when p_correct then 1 else 0 end),
    prompt_excerpt = excluded.prompt_excerpt,
    updated_at = now();
end;
$$;

revoke all on function public.record_question_attempt (uuid, uuid, text, text, text, boolean) from public;
grant execute on function public.record_question_attempt (uuid, uuid, text, text, text, boolean) to service_role;

notify pgrst, 'reload schema';

-- ----- 014_question_performance_grants.sql -----
-- 既に 013 適用済みで GRANT だけ欠けている DB 向け（冪等）
grant select on table public.question_performance to authenticated;

notify pgrst, 'reload schema';

-- ----- 015_document_chunks_pdf_page.sql -----
alter table public.document_chunks
  add column if not exists pdf_page int;

comment on column public.document_chunks.pdf_page is '1-based PDF page index for this chunk (best effort)';

notify pgrst, 'reload schema';

-- ----- 017_notebooklm_material_files.sql -----
alter table public.tests
  add column if not exists notebooklm_slide_pdf_storage_path text,
  add column if not exists notebooklm_video_mp4_storage_path text;

comment on column public.tests.pdf_storage_path is 'R2 に保存した元 PDF のオブジェクトキー';
comment on column public.tests.notebooklm_slide_pdf_storage_path is 'R2 に保存したスライド PDF のオブジェクトキー';
comment on column public.tests.notebooklm_video_mp4_storage_path is 'R2 に保存した動画 MP4 のオブジェクトキー';

alter table public.tests drop column if exists notebooklm_slide_url;
alter table public.tests drop column if exists notebooklm_video_url;

notify pgrst, 'reload schema';

-- ----- 018_notebooklm_notebook_url.sql -----
alter table public.tests
  add column if not exists notebooklm_notebook_url text;

comment on column public.tests.notebooklm_notebook_url is 'NotebookLM のノートブック URL（ブラウザのアドレスバーからコピー）';

notify pgrst, 'reload schema';

-- ----- 016_notebooklm_slide_video.sql -----
alter table public.tests
  add column if not exists notebooklm_slide_url text,
  add column if not exists notebooklm_video_url text;

comment on column public.tests.notebooklm_slide_url is 'NotebookLM 等のスライド共有 URL（Google スライドの共有リンク推奨）';
comment on column public.tests.notebooklm_video_url is 'NotebookLM 等の動画 URL（YouTube 共有リンク推奨）';

notify pgrst, 'reload schema';


-- ----- 019_notebooklm_csv_questions.sql -----
alter table public.tests
  add column if not exists quiz_source text not null default 'pdf',
  add column if not exists notebooklm_questions_json jsonb;

comment on column public.tests.quiz_source is 'テスト出題のソース種別（pdf / notebooklm_csv）';
comment on column public.tests.notebooklm_questions_json is 'NotebookLM CSV 由来の設問プール（multiple_choice / essay）';

notify pgrst, 'reload schema';


-- ----- 020_notebooklm_vocab_questions.sql -----
alter table public.tests
  add column if not exists notebooklm_vocab_questions_json jsonb;

comment on column public.tests.notebooklm_questions_json is 'NotebookLM クイズ CSV（選択式）設問プール';
comment on column public.tests.notebooklm_vocab_questions_json is 'NotebookLM 単語帳 CSV（記述式）設問プール';

update public.tests
set
  notebooklm_vocab_questions_json = notebooklm_questions_json,
  notebooklm_questions_json = null
where
  notebooklm_questions_json is not null
  and jsonb_array_length(notebooklm_questions_json) >= 3
  and not exists (
    select 1
    from jsonb_array_elements(notebooklm_questions_json) as elem
    where coalesce(elem->>'type', '') <> 'essay'
  );

notify pgrst, 'reload schema';

-- ----- 021_quiz_sessions_notebook_lm_csv_pool.sql -----
alter table public.quiz_sessions
  add column if not exists notebook_lm_csv_pool text;

alter table public.quiz_sessions
  drop constraint if exists quiz_sessions_notebook_lm_csv_pool_check;

alter table public.quiz_sessions
  add constraint quiz_sessions_notebook_lm_csv_pool_check
  check (notebook_lm_csv_pool is null or notebook_lm_csv_pool in ('quiz', 'vocab'));

comment on column public.quiz_sessions.notebook_lm_csv_pool is
  'NotebookLM CSV 出題時のプール種別（quiz=クイズCSV / vocab=単語帳CSV）。PDF・過去プール等は null。';

notify pgrst, 'reload schema';

-- ----- 022_paper_authors_venue_doi.sql -----
alter table public.tests
  add column if not exists paper_doi text,
  add column if not exists paper_venue text,
  add column if not exists paper_authors text[];

comment on column public.tests.paper_doi is '論文の DOI（過去問では未使用）';
comment on column public.tests.paper_venue is '論文の掲載誌・会議名など（過去問では未使用）';
comment on column public.tests.paper_authors is '論文の著者（保存値の配列。過去問では未使用）';

update public.tests
set
  paper_authors = array[trim(source_name)]
where
  document_type = 'paper'
  and (paper_authors is null or cardinality(paper_authors) = 0)
  and coalesce(trim(source_name), '') <> '';

notify pgrst, 'reload schema';

-- ----- 023_scispace_project_url.sql -----
alter table public.tests
  add column if not exists scispace_project_url text;

comment on column public.tests.scispace_project_url is
  'SciSpace のワークスペース・チャット等の URL（任意。NotebookLM のノート URL に相当）';

notify pgrst, 'reload schema';

-- ----- 024_pdf_filename.sql -----
alter table public.tests
  add column if not exists pdf_filename text;

comment on column public.tests.pdf_filename is
  'アップロード時の PDF ファイル名（論文の同一判定に使う。過去問では任意）';

create unique index if not exists tests_paper_pdf_filename_lower_uidx
  on public.tests (lower(pdf_filename))
  where document_type = 'paper'
    and pdf_filename is not null
    and length(trim(pdf_filename)) > 0;

notify pgrst, 'reload schema';

-- ----- 025_bookmark_lists.sql -----
-- ログインユーザーごとのブックマークリスト（複数）。教材本体にはフラグを持たない。

create table if not exists public.bookmark_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookmark_lists_name_len_chk check (
    name = btrim(name)
    and char_length(name) >= 1
    and char_length(name) <= 80
  )
);

create unique index if not exists bookmark_lists_user_name_uidx
  on public.bookmark_lists (user_id, name);

create index if not exists bookmark_lists_user_updated_idx
  on public.bookmark_lists (user_id, updated_at desc);

drop trigger if exists bookmark_lists_set_updated_at on public.bookmark_lists;
create trigger bookmark_lists_set_updated_at
before update on public.bookmark_lists
for each row execute function public.set_updated_at();

create table if not exists public.bookmark_list_items (
  list_id uuid not null references public.bookmark_lists (id) on delete cascade,
  test_id uuid not null references public.tests (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (list_id, test_id)
);

create index if not exists bookmark_list_items_test_id_idx
  on public.bookmark_list_items (test_id);

alter table public.bookmark_lists enable row level security;
alter table public.bookmark_list_items enable row level security;

drop policy if exists "bookmark_lists_select_own" on public.bookmark_lists;
create policy "bookmark_lists_select_own"
  on public.bookmark_lists for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "bookmark_lists_insert_own" on public.bookmark_lists;
create policy "bookmark_lists_insert_own"
  on public.bookmark_lists for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "bookmark_lists_update_own" on public.bookmark_lists;
create policy "bookmark_lists_update_own"
  on public.bookmark_lists for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "bookmark_lists_delete_own" on public.bookmark_lists;
create policy "bookmark_lists_delete_own"
  on public.bookmark_lists for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "bookmark_items_select_own" on public.bookmark_list_items;
create policy "bookmark_items_select_own"
  on public.bookmark_list_items for select
  to authenticated
  using (
    exists (
      select 1 from public.bookmark_lists l
      where l.id = bookmark_list_items.list_id
        and l.user_id = auth.uid()
    )
  );

drop policy if exists "bookmark_items_insert_own" on public.bookmark_list_items;
create policy "bookmark_items_insert_own"
  on public.bookmark_list_items for insert
  to authenticated
  with check (
    exists (
      select 1 from public.bookmark_lists l
      where l.id = bookmark_list_items.list_id
        and l.user_id = auth.uid()
    )
  );

drop policy if exists "bookmark_items_delete_own" on public.bookmark_list_items;
create policy "bookmark_items_delete_own"
  on public.bookmark_list_items for delete
  to authenticated
  using (
    exists (
      select 1 from public.bookmark_lists l
      where l.id = bookmark_list_items.list_id
        and l.user_id = auth.uid()
    )
  );

grant select, insert, update, delete on table public.bookmark_lists to authenticated;
grant select, insert, delete on table public.bookmark_list_items to authenticated;

notify pgrst, 'reload schema';

-- ----- 026_paper_study_status.sql -----

-- ログインユーザーごとの論文学習ステータス。教材本体には持たない。
-- 行が無いときは「未確認」。保存するのは内容確認・学習中・学習完了だけ。

create table if not exists public.paper_study_statuses (
  user_id uuid not null references public.profiles (id) on delete cascade,
  test_id uuid not null references public.tests (id) on delete cascade,
  status text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, test_id),
  constraint paper_study_statuses_status_chk check (
    status in ('content_confirmed', 'learning', 'completed')
  )
);

comment on table public.paper_study_statuses is
  'ログインユーザーごとの論文学習ステータス。行が無いときは未確認。';

create index if not exists paper_study_statuses_test_id_idx
  on public.paper_study_statuses (test_id);

create or replace function public.enforce_paper_study_status_target()
returns trigger
language plpgsql
as $$
declare
  kind text;
begin
  select t.document_type into kind
  from public.tests t
  where t.id = new.test_id;
  if kind is distinct from 'paper' then
    raise exception 'paper_study_status_not_paper'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists paper_study_statuses_paper_only on public.paper_study_statuses;
create trigger paper_study_statuses_paper_only
before insert or update on public.paper_study_statuses
for each row execute function public.enforce_paper_study_status_target();

drop trigger if exists paper_study_statuses_set_updated_at on public.paper_study_statuses;
create trigger paper_study_statuses_set_updated_at
before update on public.paper_study_statuses
for each row execute function public.set_updated_at();

alter table public.paper_study_statuses enable row level security;

drop policy if exists "paper_study_statuses_select_own" on public.paper_study_statuses;
create policy "paper_study_statuses_select_own"
  on public.paper_study_statuses for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "paper_study_statuses_insert_own" on public.paper_study_statuses;
create policy "paper_study_statuses_insert_own"
  on public.paper_study_statuses for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "paper_study_statuses_update_own" on public.paper_study_statuses;
create policy "paper_study_statuses_update_own"
  on public.paper_study_statuses for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "paper_study_statuses_delete_own" on public.paper_study_statuses;
create policy "paper_study_statuses_delete_own"
  on public.paper_study_statuses for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on table public.paper_study_statuses to authenticated;

notify pgrst, 'reload schema';

-- 027_paper_study_status_five.sql
-- 論文学習ステータスを5段階（未確認/確認中/確認済み/学習中/学習済み）にする。
-- 旧「内容確認」(content_confirmed) は「確認済み」(confirmed) に移す。
-- 未確認は引き続き行が無い状態。

alter table public.paper_study_statuses
  drop constraint if exists paper_study_statuses_status_chk;

update public.paper_study_statuses
  set status = 'confirmed'
  where status = 'content_confirmed';

alter table public.paper_study_statuses
  add constraint paper_study_statuses_status_chk check (
    status in ('checking', 'confirmed', 'learning', 'completed')
  );

notify pgrst, 'reload schema';
