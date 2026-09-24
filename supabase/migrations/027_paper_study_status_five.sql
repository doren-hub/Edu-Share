-- 論文学習ステータスを5段階（未確認/確認中/確認済み/学習中/学習済み）にする。
-- 旧「内容確認」(content_confirmed) は「確認済み」(confirmed) に移す。
-- 未確認は引き続き行が無い状態。

alter table public.paper_study_statuses
  drop constraint if exists paper_study_statuses_status_chk;

update public.paper_study_statuses
  set status = 'confirmed'
  where status = 'content_confirmed';

alter table public.paper_study_statuses
  add constraint paper_study_statuses_status_chk check (
    status in ('checking', 'confirmed', 'learning', 'completed')
  );

notify pgrst, 'reload schema';
