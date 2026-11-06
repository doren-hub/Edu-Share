-- 採点前の排他制御。DB時刻による3分のleaseと、取得ごとのfencing tokenを使う。
-- ブラウザから処理権や提出結果を書き換えて排他制御を迂回させない。
-- セッション更新はservice role APIのみ（SELECT/INSERT/DELETEの既存ポリシーは維持）。
drop policy if exists "quiz_update_own" on public.quiz_sessions;

alter table public.quiz_sessions add column if not exists grading_token uuid;
alter table public.quiz_sessions add column if not exists grading_expires_at timestamptz;

create or replace function public.claim_quiz_grading(p_session_id uuid, p_user_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_token is null then raise exception 'token must not be null'; end if;
  update public.quiz_sessions set grading_token = p_token,
    grading_expires_at = clock_timestamp() + interval '3 minutes'
  where id = p_session_id and user_id = p_user_id and answers_json is null
    and (grading_token is null or grading_expires_at <= clock_timestamp());
  return found;
end;
$$;

create or replace function public.release_quiz_grading(p_session_id uuid, p_user_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.quiz_sessions set grading_token = null, grading_expires_at = null
  where id = p_session_id and user_id = p_user_id and grading_token = p_token
    and answers_json is null;
  return found;
end;
$$;

-- トークンなしの旧保存RPCを残さない。既存の結果・統計は変更しない。
drop function if exists public.submit_quiz_with_performance(uuid, uuid, jsonb, int, int, int, jsonb, jsonb);
create or replace function public.submit_quiz_with_performance(
  p_session_id uuid,
  p_user_id uuid,
  p_answers jsonb,
  p_score_mc int,
  p_score_essay int,
  p_score_total int,
  p_feedback jsonb,
  p_attempts jsonb,
  p_grading_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_test_id uuid;
  v_attempt jsonb;
begin
  if p_answers is null or p_answers = 'null'::jsonb then
    raise exception 'answers must not be null';
  end if;

  -- 行ロックと未提出条件を同時に評価する。競合した提出は先行確定後に false となる。
  update public.quiz_sessions set
    grading_token = null,
    grading_expires_at = null,
    answers_json = p_answers,
    score_mc = p_score_mc,
    score_essay = p_score_essay,
    score_total = p_score_total,
    feedback_json = p_feedback
  where id = p_session_id and user_id = p_user_id and answers_json is null
    and grading_token = p_grading_token and grading_expires_at > clock_timestamp()
  returning test_id into v_test_id;
  if not found then
    return false;
  end if;

  if v_test_id is not null then
    if p_attempts is null or jsonb_typeof(p_attempts) <> 'array' then
      raise exception 'attempts must be an array';
    end if;
    for v_attempt in select value from jsonb_array_elements(p_attempts) loop
      perform public.record_question_attempt(
        p_user_id, v_test_id,
        v_attempt->>'question_key', v_attempt->>'prompt_excerpt',
        v_attempt->>'question_type', (v_attempt->>'correct')::boolean
      );
    end loop;
  end if;
  return true;
end;
$$;

revoke all on function public.submit_quiz_with_performance(uuid, uuid, jsonb, int, int, int, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.submit_quiz_with_performance(uuid, uuid, jsonb, int, int, int, jsonb, jsonb, uuid) to service_role;
notify pgrst, 'reload schema';

revoke all on function public.claim_quiz_grading(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_quiz_grading(uuid, uuid, uuid) to service_role;
revoke all on function public.release_quiz_grading(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_quiz_grading(uuid, uuid, uuid) to service_role;
notify pgrst, 'reload schema';
