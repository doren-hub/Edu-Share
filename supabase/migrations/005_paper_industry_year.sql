-- 論文: 業界・発表年（専門家名は既存 source_name を使用）

alter table public.tests
  add column if not exists industry text,
  add column if not exists publication_year text;

comment on column public.tests.industry is '論文の業界（過去問では未使用）';
comment on column public.tests.publication_year is '論文の発表年（過去問では未使用）';
