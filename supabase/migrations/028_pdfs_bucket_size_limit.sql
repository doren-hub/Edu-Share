-- pdfs バケットのファイルサイズ上限を 200MB にする（動画 MP4 の直接アップロード用）。
-- ※ プロジェクト全体の上限（Dashboard > Storage > Settings > Upload file size limit）が
--   これより小さいと、そちらが優先される。50MB を超えるには Pro プラン以上が必要。
update storage.buckets
set file_size_limit = 200 * 1024 * 1024
where id = 'pdfs';
