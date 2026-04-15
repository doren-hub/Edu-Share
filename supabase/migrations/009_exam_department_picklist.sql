-- 過去問: tests.exam_department（学科名）と picklist category department_name

alter table public.tests add column if not exists exam_department text;

comment on column public.tests.exam_department is
  '過去問の学科名（論文では未使用）。picklist_options.category = department_name と対応。';

alter table public.picklist_options drop constraint if exists picklist_options_category_check;

alter table public.picklist_options add constraint picklist_options_category_check check (
  category in (
    'school_name',
    'department_name',
    'expert_name',
    'exam_subject',
    'exam_period',
    'paper_industry',
    'publication_year'
  )
);

alter table public.picklist_options drop constraint if exists picklist_options_scope_allowed_chk;

alter table public.picklist_options add constraint picklist_options_scope_allowed_chk check (
  scope_school_name is null
  or category in ('exam_subject', 'exam_period', 'department_name')
);

-- 学科名の初期シードは 011（scope_department_value 列と一意インデックス作成後）で投入する

notify pgrst, 'reload schema';
