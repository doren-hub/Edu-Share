-- R2 移行に伴い、不要になった Supabase Storage の pdfs バケット用ポリシーを削除する
-- （ファイル本体は Cloudflare R2 に移管済み。DB にはオブジェクトキーのみ保持）
-- バケット自体の削除は、Supabase Storage の内部保護トリガーや外部キー制約との競合を避けるため、
-- 空であることを確認したうえで Supabase Dashboard（Storage > pdfs > Delete bucket）にて行います。

drop policy if exists "pdfs_insert_own_prefix" on storage.objects;
drop policy if exists "pdfs_select_own_prefix" on storage.objects;
drop policy if exists "pdfs_update_own_prefix" on storage.objects;
drop policy if exists "pdfs_delete_own_prefix" on storage.objects;
