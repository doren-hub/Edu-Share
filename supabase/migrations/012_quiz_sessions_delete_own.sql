drop policy if exists "quiz_delete_own" on public.quiz_sessions;
create policy "quiz_delete_own"
  on public.quiz_sessions for delete
  to authenticated
  using (auth.uid() = user_id);
