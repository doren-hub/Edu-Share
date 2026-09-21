/** 詳細ページ: マイグレーション未適用の列は外して再取得する */

export const TEST_DETAIL_BASE_SELECT =
  "id,title,description,source_name,processing_status,processing_error,created_at,document_type,exam_department,exam_subject,exam_period,industry,publication_year,paper_doi,paper_venue,paper_authors,uploaded_by,quiz_source,notebooklm_questions_json,notebooklm_vocab_questions_json";

/** pdf_filename が無い DB でも Notebook / SciSpace URL は落とさない。先頭は現行スキーマで成功する列順 */
export const TEST_DETAIL_SELECT_VARIANTS = [
  `${TEST_DETAIL_BASE_SELECT},notebooklm_slide_pdf_storage_path,notebooklm_video_mp4_storage_path,notebooklm_notebook_url,scispace_project_url,pdf_storage_path`,
  `${TEST_DETAIL_BASE_SELECT},notebooklm_slide_pdf_storage_path,notebooklm_video_mp4_storage_path,notebooklm_notebook_url,scispace_project_url,pdf_filename,pdf_storage_path`,
  `${TEST_DETAIL_BASE_SELECT},notebooklm_slide_pdf_storage_path,notebooklm_video_mp4_storage_path,notebooklm_notebook_url,scispace_project_url`,
  `${TEST_DETAIL_BASE_SELECT},notebooklm_notebook_url,scispace_project_url`,
  TEST_DETAIL_BASE_SELECT,
] as const;

export const TEST_DETAIL_LINK_COLUMNS =
  "notebooklm_notebook_url,scispace_project_url";

export function looksLikeMissingColumnError(message: string): boolean {
  const msg = message.toLowerCase();
  return (
    msg.includes("schema cache") ||
    (msg.includes("column") && msg.includes("does not exist")) ||
    msg.includes("notebooklm_slide_pdf_storage_path") ||
    msg.includes("notebooklm_video_mp4_storage_path") ||
    msg.includes("notebooklm_notebook_url") ||
    msg.includes("scispace_project_url") ||
    msg.includes("pdf_filename") ||
    msg.includes("pdf_storage_path") ||
    msg.includes("quiz_source") ||
    msg.includes("notebooklm_questions_json") ||
    msg.includes("notebooklm_vocab_questions_json") ||
    msg.includes("paper_authors") ||
    msg.includes("paper_doi") ||
    msg.includes("paper_venue")
  );
}

export function withOptionalMaterialFields(row: Record<string, unknown>) {
  return {
    ...row,
    notebooklm_slide_pdf_storage_path: row.notebooklm_slide_pdf_storage_path ?? null,
    notebooklm_video_mp4_storage_path: row.notebooklm_video_mp4_storage_path ?? null,
    notebooklm_notebook_url: row.notebooklm_notebook_url ?? null,
    scispace_project_url: row.scispace_project_url ?? null,
    pdf_filename: row.pdf_filename ?? null,
    pdf_storage_path: row.pdf_storage_path ?? null,
  };
}

export function mergeLinkColumns(
  row: Record<string, unknown>,
  links: {
    notebooklm_notebook_url?: string | null;
    scispace_project_url?: string | null;
  } | null,
) {
  if (!links) return row;
  return {
    ...row,
    notebooklm_notebook_url: links.notebooklm_notebook_url ?? null,
    scispace_project_url: links.scispace_project_url ?? null,
  };
}
