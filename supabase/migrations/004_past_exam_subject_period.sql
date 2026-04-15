-- 過去問: 科目・テスト時期（アップロード時に選択）

alter table public.tests
  add column if not exists exam_subject text,
  add column if not exists exam_period text;

comment on column public.tests.exam_subject is '過去問の科目（論文では未使用）';
comment on column public.tests.exam_period is '過去問のテスト時期（論文では未使用）';
