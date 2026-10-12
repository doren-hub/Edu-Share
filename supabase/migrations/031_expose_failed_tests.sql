-- failed の行も anon / authenticated が読めるようにする（一覧表示・PDF閲覧のため）
-- processing_error 列の非公開化は Next.js サーバー側で行う（一覧取得 select 列からの除外、未認証時のマスク）

drop policy if exists "tests_select_authenticated" on public.tests;
create policy "tests_select_authenticated"
  on public.tests for select
  to authenticated
  using (processing_status in ('ready', 'failed'));

drop policy if exists "tests_select_anon" on public.tests;
create policy "tests_select_anon"
  on public.tests for select
  to anon
  using (processing_status in ('ready', 'failed'));

notify pgrst, 'reload schema';
