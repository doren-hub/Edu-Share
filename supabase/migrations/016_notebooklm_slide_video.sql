-- NotebookLM 等で作成したスライド・動画の表示用（資料ページの横スクロール用）
alter table public.tests
  add column if not exists notebooklm_slide_url text,
  add column if not exists notebooklm_video_url text;

comment on column public.tests.notebooklm_slide_url is 'NotebookLM 等のスライド共有 URL（Google スライドの共有リンク推奨）';
comment on column public.tests.notebooklm_video_url is 'NotebookLM 等の動画 URL（YouTube 共有リンク推奨）';

notify pgrst, 'reload schema';
