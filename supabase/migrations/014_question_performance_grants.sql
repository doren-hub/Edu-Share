-- 前提: 013_question_performance.sql 適用済み（public.question_performance が存在すること）
-- 013 を未実行のまま本ファイルだけ実行すると ERROR 42P01 になります。
-- テーブル未作成なら migrations/013 を先に実行するか、sql_editor_question_performance.sql を実行してください。
--
-- RLS のみでは読めず、GRANT 不足で 42501 になる環境向けの追補です。
grant select on table public.question_performance to authenticated;

notify pgrst, 'reload schema';
