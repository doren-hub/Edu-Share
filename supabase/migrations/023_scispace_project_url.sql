alter table public.tests
  add column if not exists scispace_project_url text;

comment on column public.tests.scispace_project_url is
  'SciSpace のワークスペース・チャット等の URL（任意。NotebookLM のノート URL に相当）';

notify pgrst, 'reload schema';
