alter table public.tests
  add column if not exists quiz_source text not null default 'pdf',
  add column if not exists notebooklm_questions_json jsonb;

comment on column public.tests.quiz_source is 'テスト出題のソース種別（pdf / notebooklm_csv）';
comment on column public.tests.notebooklm_questions_json is 'NotebookLM CSV 由来の設問プール（multiple_choice / essay）';

notify pgrst, 'reload schema';
