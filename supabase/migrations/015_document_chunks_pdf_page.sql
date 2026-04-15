-- チャンクが主に該当する PDF ページ（1 始まり）。出題根拠ページの推定に使用。
alter table public.document_chunks
  add column if not exists pdf_page int;

comment on column public.document_chunks.pdf_page is '1-based PDF page index for this chunk (best effort)';
