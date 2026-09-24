-- ファイル本体は R2 へ移し、Supabase には参照用のオブジェクトキーだけを残す。
comment on column public.tests.pdf_storage_path is 'R2 に保存した元 PDF のオブジェクトキー';
comment on column public.tests.notebooklm_slide_pdf_storage_path is 'R2 に保存したスライド PDF のオブジェクトキー';
comment on column public.tests.notebooklm_video_mp4_storage_path is 'R2 に保存した動画 MP4 のオブジェクトキー';
