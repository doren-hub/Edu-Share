import { test } from "node:test";
import assert from "node:assert/strict";
import { TEST_BROWSE_COLUMNS, TEST_BROWSE_PAPER_LIST_COLUMNS } from "./test-browse-select.ts";

test("TEST_BROWSE_COLUMNS includes processing_status and processing_error", () => {
  assert.match(TEST_BROWSE_COLUMNS, /\bprocessing_status\b/);
  assert.match(TEST_BROWSE_COLUMNS, /\bprocessing_error\b/);
  assert.match(TEST_BROWSE_COLUMNS, /\bdocument_type\b/);
});

test("TEST_BROWSE_PAPER_LIST_COLUMNS includes TEST_BROWSE_COLUMNS and material paths", () => {
  assert.match(TEST_BROWSE_PAPER_LIST_COLUMNS, /notebooklm_slide_pdf_storage_path/);
  assert.match(TEST_BROWSE_PAPER_LIST_COLUMNS, /notebooklm_video_mp4_storage_path/);
  assert.match(TEST_BROWSE_PAPER_LIST_COLUMNS, /\bprocessing_status\b/);
});
