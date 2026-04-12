-- 公開テスト一覧（ready のみ）、ベクトル検索RPC、HNSWをNULL除外に

drop policy if exists "tests_select_authenticated" on public.tests;
create policy "tests_select_authenticated"
  on public.tests for select
  to authenticated
  using (processing_status = 'ready');

drop policy if exists "tests_select_anon" on public.tests;
create policy "tests_select_anon"
  on public.tests for select
  to anon
  using (processing_status = 'ready');

drop index if exists public.document_chunks_embedding_hnsw;
create index document_chunks_embedding_hnsw
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops)
  where (embedding is not null);

alter table public.tests
  add column if not exists document_type text
  default 'past_exam'
  check (document_type in ('past_exam', 'paper'));

create or replace function public.match_document_chunks (
  p_test_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 8
)
returns table (content text, similarity double precision)
language sql
stable
as $$
  select
    dc.content,
    (1 - (dc.embedding <=> p_query_embedding))::double precision as similarity
  from public.document_chunks dc
  where dc.test_id = p_test_id
    and dc.embedding is not null
  order by dc.embedding <=> p_query_embedding
  limit greatest(1, least(p_match_count, 32));
$$;

revoke all on function public.match_document_chunks (uuid, vector, int) from public;
grant execute on function public.match_document_chunks (uuid, vector, int) to service_role;
