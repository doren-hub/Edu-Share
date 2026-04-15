alter table public.tests
  add column if not exists notebooklm_notebook_url text;

comment on column public.tests.notebooklm_notebook_url is 'NotebookLM のノートブック URL（ブラウザのアドレスバーからコピー）';

notify pgrst, 'reload schema';
