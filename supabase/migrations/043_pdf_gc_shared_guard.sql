begin;

-- Shared row locks allow unrelated tests writes to overlap. GC begin still
-- takes FOR UPDATE, waits for all writers, then checks pending ingestion.
-- Keep the lock until transaction end; FOR KEY SHARE would not conflict
-- with active_run updates and is not sufficient.
create or replace function public.fence_pdf_gc_writes() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_run uuid;
begin
  select active_run into v_run from public.pdf_gc_guard where id for share;
  if not found then raise exception 'PDF GC guard missing'; end if;
  if v_run is not null then raise exception 'PDF GC maintenance active'; end if;
  if TG_OP <> 'DELETE' and exists (
    select 1 from public.pdf_gc_objects where storage_path in (
      btrim(new.pdf_storage_path), btrim(new.notebooklm_slide_pdf_storage_path),
      btrim(new.notebooklm_video_mp4_storage_path)
    )
  ) then raise exception 'PDF key retired by GC'; end if;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end; $$;

commit;
