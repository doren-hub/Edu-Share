-- failed の行も anon / authenticated が読めるようにする（一覧表示・PDF閲覧のため）
-- processing_error 列の非公開化は Next.js サーバー側で行う（一覧ページのマスク処理、テスト詳細での未認証マスク）

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

-- 上記以外の未知・生例外が残っている場合は安全な定型文で上書き
update public.tests
set processing_error = 'PDFの取り込みに失敗しました。時間をおいて再試行するか、別のPDFをお試しください。'
where processing_status = 'failed'
  and processing_error is not null
  and processing_error not in (
    'PDF本文に含まれるUnicode文字の処理に失敗しました。',
    '埋め込みAPIの認証に失敗しました。管理者へお問い合わせください。',
    'ファイルストレージへの保存に失敗しました。時間をおいて再試行してください。',
    'PDFの解析に失敗しました（暗号化PDFや破損ファイルの可能性があります）。',
    'PDFから本文テキストを自動抽出できませんでした（画像のみ・スキャンなどの可能性）。テキストがコピーできるPDFへの差し替えを推奨します。',
    'API呼び出しの上限に達しました。時間をおいて再試行してください。',
    'PDFの取り込みに失敗しました。時間をおいて再試行するか、別のPDFをお試しください。'
  );

notify pgrst, 'reload schema';
