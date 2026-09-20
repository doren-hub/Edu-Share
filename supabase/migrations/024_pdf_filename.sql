-- 論文の元 PDF ファイル名（同一名の再アップロード判定用）
alter table public.tests
  add column if not exists pdf_filename text;

comment on column public.tests.pdf_filename is
  'アップロード時の PDF ファイル名（論文の同一判定に使う。過去問では任意）';

create unique index if not exists tests_paper_pdf_filename_lower_uidx
  on public.tests (lower(pdf_filename))
  where document_type = 'paper'
    and pdf_filename is not null
    and length(trim(pdf_filename)) > 0;

notify pgrst, 'reload schema';
