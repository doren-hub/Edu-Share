-- picklist_options へ API ロールからの参照・更新が通るよう明示 GRANT
-- （006 実行後も「permission denied」になるプロジェクト向け）

grant select on table public.picklist_options to anon, authenticated;
grant insert, delete on table public.picklist_options to authenticated;
