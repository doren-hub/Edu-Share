-- 科目・テストの時期を「学校＋学科」でスコープ（学科ごとに追加・削除した候補を分離）

alter table public.picklist_options
  add column if not exists scope_department_value text null;

comment on column public.picklist_options.scope_department_value is
  'exam_subject / exam_period のみ。学校内の学科（tests.exam_department と同一の表記）専用。NULL は全校共通またはその学校の全学科共通。';

alter table public.picklist_options
  drop constraint if exists picklist_options_dept_scope_chk;

alter table public.picklist_options
  add constraint picklist_options_dept_scope_chk check (
    scope_department_value is null
    or (
      category in ('exam_subject', 'exam_period')
      and scope_school_name is not null
      and btrim(scope_department_value) <> ''
    )
  );

drop index if exists picklist_options_global_cat_value;
drop index if exists picklist_options_scoped_cat_value_school;
drop index if exists picklist_options_scoped_school_only_cat_value;
drop index if exists picklist_options_scoped_school_dept_cat_value;

create unique index picklist_options_global_cat_value
  on public.picklist_options (category, value)
  where scope_school_name is null
    and (scope_department_value is null or btrim(scope_department_value) = '');

create unique index picklist_options_scoped_school_only_cat_value
  on public.picklist_options (category, value, scope_school_name)
  where scope_school_name is not null
    and (scope_department_value is null or btrim(scope_department_value) = '');

create unique index picklist_options_scoped_school_dept_cat_value
  on public.picklist_options (category, value, scope_school_name, scope_department_value)
  where scope_school_name is not null
    and scope_department_value is not null
    and btrim(scope_department_value) <> '';

-- 部分一意インデックスの WHERE と ON CONFLICT の WHERE を一致させる（42P10 防止）
insert into public.picklist_options (category, value, sort_order) values
  ('department_name', '普通科', 10),
  ('department_name', '理数科', 20),
  ('department_name', '総合学科', 30),
  ('department_name', '体育・芸術科', 40),
  ('department_name', '国際科', 50),
  ('department_name', '探求科', 60),
  ('department_name', 'その他', 9999)
on conflict (category, value) where (
  scope_school_name is null
  and (scope_department_value is null or btrim(scope_department_value) = '')
) do nothing;

notify pgrst, 'reload schema';
