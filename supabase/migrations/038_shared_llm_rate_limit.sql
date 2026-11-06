-- Apply only via the owner's normal migration process. No external services required.
create table public.llm_rate_limit_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('ask', 'quizStart', 'quizSubmit', 'summarize')),
  timestamps timestamptz[] not null default '{}',
  primary key (user_id, kind)
);
alter table public.llm_rate_limit_buckets enable row level security;
revoke all on public.llm_rate_limit_buckets from public, anon, authenticated;
grant select, insert, update on public.llm_rate_limit_buckets to service_role;

create function public.consume_llm_rate_limit(
  p_user_id uuid, p_kind text, p_window_ms integer, p_max_requests integer
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz;
  v_fresh timestamptz[];
  v_retry integer;
begin
  if p_user_id is null or p_kind is null or p_kind not in ('ask', 'quizStart', 'quizSubmit', 'summarize')
    or p_window_ms is null or p_window_ms < 1 or p_window_ms > 60000
    or p_max_requests is null or p_max_requests < 1 or p_max_requests > 10 then
    raise exception 'Invalid rate limit parameters';
  end if;
  -- A unique key handles simultaneous first use; the row lock serializes every
  -- subsequent read/prune/admit across app instances in one transaction.
  insert into public.llm_rate_limit_buckets(user_id, kind) values (p_user_id, p_kind)
    on conflict do nothing;
  select timestamps into v_fresh from public.llm_rate_limit_buckets
    where user_id = p_user_id and kind = p_kind for update;
  -- Read the database clock AFTER acquiring the lock, not transaction start time.
  v_now := clock_timestamp();
  select coalesce(array_agg(t order by t), '{}'::timestamptz[]) into v_fresh
    from unnest(v_fresh) t where t > v_now - p_window_ms * interval '1 millisecond';
  if cardinality(v_fresh) >= p_max_requests then
    v_retry := greatest(1, ceil(extract(epoch from
      (v_fresh[1] + p_window_ms * interval '1 millisecond' - v_now)))::integer);
    return jsonb_build_object('allowed', false, 'retry_after_seconds', v_retry);
  end if;
  update public.llm_rate_limit_buckets set timestamps = array_append(v_fresh, v_now)
    where user_id = p_user_id and kind = p_kind;
  return jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
end;
$$;
revoke all on function public.consume_llm_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_llm_rate_limit(uuid, text, integer, integer) to service_role;
