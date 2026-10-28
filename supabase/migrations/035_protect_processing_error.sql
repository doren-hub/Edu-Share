-- #75: RLS continues to expose ready/failed rows, but anon cannot read errors.
-- Table-level SELECT overrides column ACLs, including grants inherited from PUBLIC.
-- Keep this explicit allowlist up to date when adding public tests columns.
begin;

revoke select on table public.tests from anon, public;
revoke select (processing_error) on table public.tests from anon, public;

grant select (
  id, title, description, pdf_storage_path, source_type, source_name, uploaded_by,
  processing_status, created_at, document_type, exam_subject, exam_period,
  industry, publication_year, exam_department, notebooklm_slide_pdf_storage_path,
  notebooklm_video_mp4_storage_path, notebooklm_notebook_url, quiz_source,
  notebooklm_questions_json, notebooklm_vocab_questions_json, paper_doi,
  paper_venue, paper_authors, scispace_project_url, pdf_filename, industries
) on table public.tests to anon;

-- Preserve authenticated detail pages, including ready-state extraction notices.
grant select on table public.tests to authenticated;

notify pgrst, 'reload schema';
commit;
