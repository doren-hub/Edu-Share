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
