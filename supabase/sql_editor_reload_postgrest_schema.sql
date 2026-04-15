-- =============================================================================
-- PostgREST のスキーマキャッシュを手動で再読み込みする
-- =============================================================================
-- 使い方:
--   マイグレーション後も「Could not find the '...' column ... in the schema cache」が
--   続くとき、SQL Editor で Run してください。
--
--   Run のあと:
--   Supabase の API（PostgREST）が DB の列一覧を読み直すまで、**数十秒〜1分程度**かかることがあります。
--   その間にアプリから PDF を送ると、まだ古い一覧のままで同じエラーになることがあります。
--   **少し待ってから**、アプリの「PDFアップロード」画面で、**ファイルを選び直して送信し直す**（＝再アップロード）操作をしてください。
--
-- 公式: https://supabase.com/docs/guides/troubleshooting/refresh-postgrest-schema
-- =============================================================================

notify pgrst, 'reload schema';

-- 通知キューが詰まっている場合のヒント（結果に数値が出ればOK）
select pg_notification_queue_usage() as notification_queue_usage;
