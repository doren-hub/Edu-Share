-- Validate statistics against the locked session snapshot; no existing data changes.
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
  v_questions jsonb;
  v_question jsonb;
  v_parts text[];
  v_key text;
  v_index int := 0;
  -- ECMAScript String.trim whitespace, matching makeQuestionPerformanceKey.
  v_space text := chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)
    ||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)
    ||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)
    ||chr(8287)||chr(12288)||chr(65279);
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
  returning test_id, questions_json into v_test_id, v_questions;
  if not found then
    return false;
  end if;

  if v_test_id is not null then
    if p_attempts is null or jsonb_typeof(p_attempts) <> 'array' then
      raise exception 'attempts must be an array';
    end if;
    if jsonb_typeof(v_questions) is distinct from 'array' then
      raise exception 'session questions must be an array';
    end if;
    if jsonb_array_length(p_attempts) <> jsonb_array_length(v_questions) then
      raise exception 'attempts must cover every session question';
    end if;
    -- Ordered occurrence matching preserves duplicate-key counts without permitting
    -- missing, extra, reordered or foreign-test/question statistics.
    for v_attempt in select value from jsonb_array_elements(p_attempts) loop
      v_question := v_questions->v_index;
      v_index := v_index + 1;
      v_parts := array[v_test_id::text, v_question->>'type', btrim(v_question->>'prompt', v_space)];
      if v_question->>'type' = 'multiple_choice' then
        v_parts := v_parts || array(select btrim(value, v_space)
          from jsonb_array_elements_text(v_question->'options'));
        v_parts := array_append(v_parts, v_question->>'correctIndex');
      elsif v_question->>'type' = 'essay' then
        v_parts := array_append(v_parts, btrim(coalesce(v_question->>'referenceAnswer', ''), v_space));
      else
        raise exception 'unsupported session question type';
      end if;
      v_key := left(encode(sha256(convert_to(array_to_string(v_parts, chr(30)), 'UTF8')), 'hex'), 48);
      if jsonb_typeof(v_attempt) is distinct from 'object'
        or (v_attempt->>'question_key') is distinct from v_key
        or (v_attempt->>'question_type') is distinct from (v_question->>'type')
        or jsonb_typeof(v_attempt->'correct') is distinct from 'boolean'
        or jsonb_typeof(v_attempt->'prompt_excerpt') is distinct from 'string' then
        raise exception 'attempt does not match session question';
      end if;
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

