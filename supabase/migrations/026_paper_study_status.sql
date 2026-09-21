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
