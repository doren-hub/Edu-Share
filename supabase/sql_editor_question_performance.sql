-- 設問ごとの正答率（question_performance + RPC + GRANT）
-- Supabase SQL エディタで「このファイルだけ」実行してよいワンショット用です。
-- 014 のみを先に実行すると relation does not exist になるため、未作成なら必ず本ファイル（または 013）から実行してください。

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
