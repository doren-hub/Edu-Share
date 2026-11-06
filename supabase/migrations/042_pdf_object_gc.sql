-- Offline maintenance fence. No TTL: a crashed collector must be stopped and
-- explicitly released by the owner, never concurrently replaced.
create table if not exists public.pdf_gc_guard (
  id boolean primary key default true check (id),
  active_run uuid
);
insert into public.pdf_gc_guard(id) values (true) on conflict do nothing;
create table if not exists public.pdf_gc_runs (
  id uuid primary key,
  operator text not null,
  approval text not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);
create table if not exists public.pdf_gc_objects (
  storage_path text primary key,
  run_id uuid not null references public.pdf_gc_runs,
  last_modified timestamptz not null,
  etag text not null,
  status text not null check (status in ('reserved', 'deleted', 'failed')),
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.pdf_gc_guard enable row level security;
alter table public.pdf_gc_runs enable row level security;
alter table public.pdf_gc_objects enable row level security;
revoke all on public.pdf_gc_guard, public.pdf_gc_runs, public.pdf_gc_objects from public, anon, authenticated, service_role;
grant select on public.pdf_gc_guard, public.pdf_gc_runs, public.pdf_gc_objects to service_role;

-- Every tests mutation acquires the same row lock as begin/reserve/end. This
-- also fences old app versions and service-role writes; RLS alone cannot do so.
create or replace function public.fence_pdf_gc_writes() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_run uuid;
begin
  select active_run into v_run from public.pdf_gc_guard where id for update;
  if not found then raise exception 'PDF GC guard missing'; end if;
  if v_run is not null then raise exception 'PDF GC maintenance active'; end if;
  if TG_OP <> 'DELETE' and exists (
    select 1 from public.pdf_gc_objects where storage_path in (
      new.pdf_storage_path, new.notebooklm_slide_pdf_storage_path,
      new.notebooklm_video_mp4_storage_path
    )
  ) then raise exception 'PDF key retired by GC'; end if;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end; $$;
revoke all on function public.fence_pdf_gc_writes() from public, anon, authenticated, service_role;
drop trigger if exists fence_pdf_gc_writes on public.tests;
create trigger fence_pdf_gc_writes before insert or update or delete on public.tests
for each row execute function public.fence_pdf_gc_writes();

create or replace function public.begin_pdf_gc(p_run uuid, p_operator text, p_approval text)
returns void language plpgsql security definer set search_path = public as $$
declare v_run uuid;
begin
  if p_run is null or nullif(btrim(p_operator),'') is null or nullif(btrim(p_approval),'') is null then
    raise exception 'Run, operator and explicit owner approval required';
  end if;
  select active_run into v_run from public.pdf_gc_guard where id for update;
  if not found or v_run is not null then raise exception 'PDF GC guard unavailable'; end if;
  if exists (select 1 from public.tests where processing_status = 'pending' or pdf_processing_token is not null) then
    raise exception 'PDF ingestion still active; stop and drain writers first';
  end if;
  insert into public.pdf_gc_runs(id,operator,approval) values(p_run,p_operator,p_approval);
  update public.pdf_gc_guard set active_run = p_run where id;
end; $$;

-- Read-only preview is provisional: execute always rechecks under the fence.
create or replace function public.pdf_gc_reason(p_key text, p_modified timestamptz)
returns text language plpgsql security definer set search_path = public as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.pdf$' then
    return 'outside-source-pdf-namespace';
  end if;
  if p_modified is null or p_modified > clock_timestamp() - interval '7 days' then return 'within-seven-day-grace'; end if;
  if exists (select 1 from public.tests where p_key in (
    btrim(pdf_storage_path), btrim(notebooklm_slide_pdf_storage_path), btrim(notebooklm_video_mp4_storage_path)
  )) then return 'referenced'; end if;
  if exists (select 1 from public.tests where processing_status = 'pending' or pdf_processing_token is not null) then
    return 'ingestion-active';
  end if;
  return 'unreferenced-source-pdf-older-than-seven-days';
end; $$;

create or replace function public.reserve_pdf_gc_object(p_run uuid, p_key text, p_modified timestamptz, p_etag text)
returns void language plpgsql security definer set search_path = public as $$
declare v_run uuid; v_reason text;
begin
  select active_run into v_run from public.pdf_gc_guard where id for update;
  if not found or v_run is distinct from p_run or p_run is null then raise exception 'PDF GC run mismatch'; end if;
  v_reason := public.pdf_gc_reason(p_key,p_modified);
  if v_reason <> 'unreferenced-source-pdf-older-than-seven-days' then raise exception 'PDF GC unsafe: %', v_reason; end if;
  if nullif(btrim(p_etag),'') is null then raise exception 'ETag required'; end if;
  insert into public.pdf_gc_objects(storage_path,run_id,last_modified,etag,status)
    values(p_key,p_run,p_modified,p_etag,'reserved')
    on conflict(storage_path) do update set run_id=excluded.run_id,
      last_modified=excluded.last_modified,etag=excluded.etag,status='reserved',updated_at=clock_timestamp();
end; $$;
create or replace function public.finish_pdf_gc_object(p_run uuid, p_key text, p_deleted boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_run uuid;
begin
  select active_run into v_run from public.pdf_gc_guard where id for update;
  if not found or v_run is distinct from p_run or p_run is null or p_deleted is null then raise exception 'PDF GC run mismatch'; end if;
  update public.pdf_gc_objects set status=case when p_deleted then 'deleted' else 'failed' end,
    updated_at=clock_timestamp() where storage_path=p_key and run_id=p_run;
  if not found then raise exception 'PDF GC reservation missing'; end if;
end; $$;
create or replace function public.end_pdf_gc(p_run uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_run uuid;
begin
  select active_run into v_run from public.pdf_gc_guard where id for update;
  if not found or v_run is distinct from p_run or p_run is null then raise exception 'PDF GC run mismatch'; end if;
  update public.pdf_gc_runs set finished_at=clock_timestamp() where id=p_run;
  update public.pdf_gc_guard set active_run=null where id;
end; $$;
revoke all on function public.begin_pdf_gc(uuid,text,text), public.pdf_gc_reason(text,timestamptz),
  public.reserve_pdf_gc_object(uuid,text,timestamptz,text), public.finish_pdf_gc_object(uuid,text,boolean),
  public.end_pdf_gc(uuid) from public, anon, authenticated;
grant execute on function public.begin_pdf_gc(uuid,text,text), public.pdf_gc_reason(text,timestamptz),
  public.reserve_pdf_gc_object(uuid,text,timestamptz,text), public.finish_pdf_gc_object(uuid,text,boolean),
  public.end_pdf_gc(uuid) to service_role;
