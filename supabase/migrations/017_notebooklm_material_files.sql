-- NotebookLM 用スライド（PDF）・動画（MP4）を Storage に保存するためのパス
alter table public.tests
  add column if not exists notebooklm_slide_pdf_storage_path text,
  add column if not exists notebooklm_video_mp4_storage_path text;

comment on column public.tests.notebooklm_slide_pdf_storage_path is 'R2 に保存したスライド PDF のオブジェクトキー';
comment on column public.tests.notebooklm_video_mp4_storage_path is 'R2 に保存した動画 MP4 のオブジェクトキー';

-- 旧 URL 列はファイルアップロードに置き換え
alter table public.tests drop column if exists notebooklm_slide_url;
alter table public.tests drop column if exists notebooklm_video_url;

notify pgrst, 'reload schema';
