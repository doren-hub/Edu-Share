-- 論文の代表ベクトル（document_chunks.embedding の平均）を求め、cosine 類似度が高い論文を k 件返す RPC
-- match_document_chunks と同様、service_role のみ実行可とする

create or replace function public.match_related_papers (
  p_test_id uuid,
  p_match_count int default 5
)
returns table (
  id uuid,
  similarity double precision
)
language sql
stable
as $$
  with target as (
    select avg(embedding) as rep_vector
    from public.document_chunks
    where test_id = p_test_id
      and embedding is not null
    having avg(embedding) is not null
  ),
  candidates as (
    select
      t.id,
      avg(dc.embedding) as rep_vector
    from public.tests t
    join public.document_chunks dc on dc.test_id = t.id
    where t.id <> p_test_id
      and t.document_type = 'paper'
      and t.processing_status = 'ready'
      and dc.embedding is not null
    group by t.id
    having avg(dc.embedding) is not null
  )
  select
    c.id,
    (1 - (c.rep_vector <=> target.rep_vector))::double precision as similarity
  from candidates c
  cross join target
  order by c.rep_vector <=> target.rep_vector
  limit greatest(1, least(coalesce(p_match_count, 5), 50));
$$;

revoke all on function public.match_related_papers (uuid, int) from public;
grant execute on function public.match_related_papers (uuid, int) to service_role;
