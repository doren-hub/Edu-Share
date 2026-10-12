import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeBrowseTestRow, sanitizeBrowseTestRows } from "./sanitize-browse-test-row.ts";

test("sanitizeBrowseTestRow: failed のテストでは processing_error を null にマスクする", () => {
  const failed = {
    id: "f1",
    processing_status: "failed",
    processing_error: "Some raw error message",
  };
  const sanitized = sanitizeBrowseTestRow(failed);
  assert.equal(sanitized.processing_error, null);
  assert.equal(sanitized.processing_status, "failed");
});

test("sanitizeBrowseTestRow: ready のテキスト未抽出行では processing_error を保持する", () => {
  const readyWithExtractionError = {
    id: "r1",
    processing_status: "ready",
    processing_error: "PDFから本文テキストを自動抽出できませんでした",
  };
  const sanitized = sanitizeBrowseTestRow(readyWithExtractionError);
  assert.equal(sanitized.processing_error, "PDFから本文テキストを自動抽出できませんでした");
});

test("sanitizeBrowseTestRows: 複数件の配列を一括処理する", () => {
  const rows = [
    { id: "1", processing_status: "failed", processing_error: "error 1" },
    { id: "2", processing_status: "ready", processing_error: "テキスト未抽出" },
    { id: "3", processing_status: "ready", processing_error: null },
  ];
  const out = sanitizeBrowseTestRows(rows);
  assert.equal(out[0]!.processing_error, null);
  assert.equal(out[1]!.processing_error, "テキスト未抽出");
  assert.equal(out[2]!.processing_error, null);
});
