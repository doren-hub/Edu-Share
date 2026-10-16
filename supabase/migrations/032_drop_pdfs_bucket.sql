-- R2 移行に伴い、不要になった Supabase Storage の pdfs バケットとそのポリシーを削除する
-- （ファイル本体は Cloudflare R2 に移管済み。DB にはオブジェクトキーのみ保持）

drop policy if exists "pdfs_insert_own_prefix" on storage.objects;
drop policy if exists "pdfs_select_own_prefix" on storage.objects;
drop policy if exists "pdfs_update_own_prefix" on storage.objects;
drop policy if exists "pdfs_delete_own_prefix" on storage.objects;

delete from storage.objects where bucket_id = 'pdfs';
delete from storage.buckets where id = 'pdfs';
