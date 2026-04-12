-- チャンク本文はサーバー（service role）経由のみ参照させる（クライアント直読み防止）
drop policy if exists "chunks_select_authenticated_ready" on public.document_chunks;
