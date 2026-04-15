alter table public.tests
  add column if not exists notebooklm_vocab_questions_json jsonb;

comment on column public.tests.notebooklm_questions_json is 'NotebookLM クイズ CSV（選択式）設問プール';
comment on column public.tests.notebooklm_vocab_questions_json is 'NotebookLM 単語帳 CSV（記述式）設問プール';

-- 旧データ: 単語帳のみ（essay のみ）だった行を専用列へ移す
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
