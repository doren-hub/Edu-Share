-- Service-role only. A failed DELETE, INSERT or final update rolls back everything.
-- No production changes are made until this migration is applied by the owner.
create or replace function public.replace_test_pdf_chunks(
  p_test_id uuid,
  p_storage_path text,
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
    processing_error = p_processing_error
    where id = p_test_id;
end;
$$;
revoke all on function public.replace_test_pdf_chunks(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.replace_test_pdf_chunks(uuid, text, jsonb, text)
  to service_role;
