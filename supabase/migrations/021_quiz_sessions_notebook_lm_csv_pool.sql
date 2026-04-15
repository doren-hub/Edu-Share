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
