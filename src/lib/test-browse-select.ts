/** 一覧・最近追加で共通利用する tests の select 列 */
export const TEST_BROWSE_COLUMNS =
  "id,title,description,source_name,processing_status,processing_error,created_at,document_type,exam_department,exam_subject,exam_period,industry,publication_year,paper_doi,paper_venue,paper_authors";

/** 論文一覧専用: NotebookLM の CSV プール・スライド・動画の有無表示用（JSON は件数判定のみに使用） */
export const TEST_BROWSE_PAPER_LIST_COLUMNS = `${TEST_BROWSE_COLUMNS},notebooklm_slide_pdf_storage_path,notebooklm_video_mp4_storage_path,notebooklm_questions_json,notebooklm_vocab_questions_json`;
