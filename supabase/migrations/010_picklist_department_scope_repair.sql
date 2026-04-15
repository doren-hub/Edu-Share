-- 008 のみ適用済みで 009 を未実行の環境向け修復:
--   department_name に scope_school_name を付けた行を許可し、category に department_name を含める。
-- 009 適用済みでも冪等（制約を同内容で差し替えるだけ）。

alter table public.tests add column if not exists exam_department text;

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

insert into public.picklist_options (category, value, sort_order)
select v.category, v.value, v.sort_order
from (
  values
    ('department_name', '普通科', 10),
    ('department_name', '理数科', 20),
    ('department_name', '総合学科', 30),
    ('department_name', '体育・芸術科', 40),
    ('department_name', '国際科', 50),
    ('department_name', '探求科', 60),
    ('department_name', 'その他', 9999)
) as v(category, value, sort_order)
where not exists (
  select 1
  from public.picklist_options p
  where p.category = v.category
    and p.value = v.value
    and p.scope_school_name is null
);

notify pgrst, 'reload schema';
