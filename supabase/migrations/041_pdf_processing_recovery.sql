-- Deploy only with old workers stopped: the old unfenced RPC is removed.
begin;
alter table public.tests
  add column pdf_processing_token uuid,
  add column pdf_processing_started_at timestamptz;

create table public.pdf_processing_recoveries (
  id bigint generated always as identity primary key,
  test_id uuid not null,
  processing_token uuid,
  processing_started_at timestamptz,
  recovered_at timestamptz not null default clock_timestamp(),
  operator_name text not null,
  reason text not null
);
alter table public.pdf_processing_recoveries enable row level security;
revoke all on public.pdf_processing_recoveries from public, anon, authenticated;
grant select, insert on public.pdf_processing_recoveries to service_role;
grant usage, select on sequence public.pdf_processing_recoveries_id_seq to service_role;

-- No unfenced overload may remain callable by delayed workers.
drop function public.replace_test_pdf_chunks(uuid, text, jsonb, text);
create or replace function public.replace_test_pdf_chunks(
  p_test_id uuid,
  p_storage_path text,
  p_processing_token uuid,
  p_chunks jsonb,
  p_processing_error text default null
) returns void
language plpgsql
security invoker
set search_path = public, extensions
as $$
begin
  perform 1 from public.tests
    where id = p_test_id and processing_status = 'pending'
      and pdf_processing_token = p_processing_token
    for update;
  if not found then
    raise exception 'Test is missing or not pending';
  end if;

  delete from public.document_chunks where test_id = p_test_id;
  -- Do not catch errors: PostgreSQL rolls back the deletion if any row fails.
  insert into public.document_chunks (test_id, chunk_index, content, pdf_page, embedding)
    select p_test_id, c.chunk_index, c.content, c.pdf_page, c.embedding::vector
    from jsonb_to_recordset(p_chunks) as c(
      chunk_index integer, content text, pdf_page integer, embedding text
    );

  update public.tests set
    pdf_storage_path = p_storage_path,
    processing_status = 'ready',
    processing_error = p_processing_error,
    pdf_processing_token = null,
    pdf_processing_started_at = null
    where id = p_test_id;
end;
$$;
revoke all on function public.replace_test_pdf_chunks(uuid, text, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.replace_test_pdf_chunks(uuid, text, uuid, jsonb, text)
  to service_role;

-- Explicit operator recovery, never an age-based lease expiry. The observed
-- generation (including NULL for legacy rows) must still match under row lock.
create function public.recover_test_pdf_processing(
  p_test_id uuid,
  p_expected_token uuid,
  p_expected_started_at timestamptz,
  p_operator_name text,
  p_reason text,
  p_stopped_confirmed boolean
) returns void
language plpgsql security invoker set search_path = public
as $$
begin
  if p_stopped_confirmed is distinct from true
    or nullif(btrim(p_operator_name), '') is null
    or nullif(btrim(p_reason), '') is null then
    raise exception 'Stopped-worker confirmation, operator and reason are required';
  end if;
  perform 1 from public.tests
    where id = p_test_id and processing_status = 'pending'
      and pdf_processing_token is not distinct from p_expected_token
      and pdf_processing_started_at is not distinct from p_expected_started_at
    for update;
  if not found then
    raise exception 'Pending generation changed; inspect again';
  end if;
  insert into public.pdf_processing_recoveries
    (test_id, processing_token, processing_started_at, operator_name, reason)
    values (p_test_id, p_expected_token, p_expected_started_at, p_operator_name, p_reason);
  update public.tests set processing_status = 'failed',
    processing_error = '停止したPDF取り込みを管理者が復旧しました。PDFを再アップロードしてください。',
    pdf_processing_token = null, pdf_processing_started_at = null
    where id = p_test_id;
end;
$$;
revoke all on function public.recover_test_pdf_processing(uuid, uuid, timestamptz, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.recover_test_pdf_processing(uuid, uuid, timestamptz, text, text, boolean)
  to service_role;
notify pgrst, 'reload schema';
commit;
