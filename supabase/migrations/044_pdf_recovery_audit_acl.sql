-- Restrict existing audit objects even when Supabase default privileges granted
-- ALL to service_role at creation. BYPASSRLS does not bypass these object ACLs.
begin;
revoke all on table public.pdf_processing_recoveries
  from public, anon, authenticated, service_role;
grant select, insert on table public.pdf_processing_recoveries to service_role;

revoke all on sequence public.pdf_processing_recoveries_id_seq
  from public, anon, authenticated, service_role;
grant usage, select on sequence public.pdf_processing_recoveries_id_seq to service_role;
notify pgrst, 'reload schema';
commit;
