-- match_related_papers を拡張し、絞り込み対象の論文 ID 配列（p_candidate_ids）が指定された場合に
-- その集合内に限定してコサイン類似度が高い論文を探索できるようにする。
-- match_document_chunks と同様、service_role のみ実行可とする。

-- 033 の (uuid, int) シグネチャを削除し、引数オーバーロードによる PostgREST PGRST203（曖昧さ解決エラー）を防止する
drop function if exists public.match_related_papers (uuid, int);

create or replace function public.match_related_papers (
  p_test_id uuid,
  p_match_count int default 5,
  p_candidate_ids uuid[] default null
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
      and (p_candidate_ids is null or t.id = any(p_candidate_ids))
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
  limit greatest(1, least(coalesce(p_match_count, 5), 200));
$$;

revoke all on function public.match_related_papers (uuid, int, uuid[]) from public;
grant execute on function public.match_related_papers (uuid, int, uuid[]) to service_role;
