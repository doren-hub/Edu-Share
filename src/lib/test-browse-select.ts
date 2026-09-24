/** 一覧・最近追加で共通利用する tests の select 列 */
export const TEST_BROWSE_COLUMNS =
  "id,title,description,source_name,processing_status,processing_error,created_at,document_type,exam_department,exam_subject,exam_period,industry,industries,publication_year,paper_doi,paper_venue,paper_authors";

/** 論文一覧: JSON は先頭3件だけ取り、全問は載せない */
export const TEST_BROWSE_PAPER_JSON_SLICES =
  "nq0:notebooklm_questions_json->0,nq1:notebooklm_questions_json->1,nq2:notebooklm_questions_json->2,nv0:notebooklm_vocab_questions_json->0,nv1:notebooklm_vocab_questions_json->1,nv2:notebooklm_vocab_questions_json->2";

export const TEST_BROWSE_PAPER_LIST_COLUMNS = `${TEST_BROWSE_COLUMNS},notebooklm_slide_pdf_storage_path,notebooklm_video_mp4_storage_path,${TEST_BROWSE_PAPER_JSON_SLICES}`;
