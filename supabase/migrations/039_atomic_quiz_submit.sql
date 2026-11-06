-- API (service role) 専用。結果保存と設問別統計を一括コミットする。
-- 既存の提出結果・統計は変更しない。途中例外は結果保存も含めロールバックされる。
create or replace function public.submit_quiz_with_performance(
  p_session_id uuid,
  p_user_id uuid,
  p_answers jsonb,
  p_score_mc int,
  p_score_essay int,
  p_score_total int,
  p_feedback jsonb,
  p_attempts jsonb
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
    answers_json = p_answers,
    score_mc = p_score_mc,
    score_essay = p_score_essay,
    score_total = p_score_total,
    feedback_json = p_feedback
  where id = p_session_id and user_id = p_user_id and answers_json is null
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

revoke all on function public.submit_quiz_with_performance(uuid, uuid, jsonb, int, int, int, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.submit_quiz_with_performance(uuid, uuid, jsonb, int, int, int, jsonb, jsonb) to service_role;
notify pgrst, 'reload schema';
