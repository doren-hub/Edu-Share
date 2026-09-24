-- 論文: 業界を複数選択可能にする（industries は保存値の配列。industry は先頭値の互換用に残す）

alter table public.tests
  add column if not exists industries text[];

comment on column public.tests.industries is '論文の業界（保存値の配列。過去問では未使用）';

update public.tests
set
  industries = array[trim(industry)]
where
  document_type = 'paper'
  and (industries is null or cardinality(industries) = 0)
  and coalesce(trim(industry), '') <> '';

notify pgrst, 'reload schema';
