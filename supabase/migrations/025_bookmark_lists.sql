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
