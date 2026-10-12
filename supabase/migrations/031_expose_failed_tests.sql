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

-- 既存の failed 行に含まれる生エラーメッセージ（内部キーや生例外）を安全な文言にクリーンアップ
update public.tests
set processing_error = 'PDF本文に含まれるUnicode文字の処理に失敗しました。'
where processing_status = 'failed' and processing_error like '%unsupported Unicode escape sequence%';

update public.tests
set processing_error = '埋め込みAPIの認証に失敗しました。管理者へお問い合わせください。'
where processing_status = 'failed' and processing_error like '%Incorrect API key%';

notify pgrst, 'reload schema';
