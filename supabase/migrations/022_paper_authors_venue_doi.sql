-- 論文: 著者（複数）・掲載・DOI（source_name は一覧用に著者名を連結して同期）

alter table public.tests
  add column if not exists paper_doi text,
  add column if not exists paper_venue text,
  add column if not exists paper_authors text[];

comment on column public.tests.paper_doi is '論文の DOI（過去問では未使用）';
comment on column public.tests.paper_venue is '論文の掲載誌・会議名など（過去問では未使用）';
comment on column public.tests.paper_authors is '論文の著者（保存値の配列。過去問では未使用）';

update public.tests
set
  paper_authors = array[trim(source_name)]
where
  document_type = 'paper'
  and (paper_authors is null or cardinality(paper_authors) = 0)
  and coalesce(trim(source_name), '') <> '';

notify pgrst, 'reload schema';
