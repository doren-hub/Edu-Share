import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTargets,
  type BackfillTarget,
  type DbTestRow,
} from "../../tools/backfill-pdf-filename.ts";

test("classifyTargets: 正常に更新対象を抽出できる", () => {
  const targets: BackfillTarget[] = [
    {
      testId: "test-1",
      originalFilename: "sample.pdf",
      normalizedFilename: "sample.pdf",
      workDir: "dir-1",
    },
  ];
  const dbRows: DbTestRow[] = [
    {
      id: "test-1",
      title: "Sample Paper",
      document_type: "paper",
      processing_status: "ready",
      pdf_filename: null,
    },
  ];

  const res = classifyTargets(targets, dbRows);
  assert.equal(res.toUpdate.length, 1);
  assert.equal(res.toUpdate[0].testId, "test-1");
  assert.equal(res.alreadySet.length, 0);
  assert.equal(res.notFoundInDb.length, 0);
  assert.equal(res.skippedNotPaper.length, 0);
  assert.equal(res.skippedCollision.length, 0);
  assert.equal(res.unmatchedDbPapers.length, 0);
});

test("classifyTargets: 既に pdf_filename が入っている場合は alreadySet に分類される", () => {
  const targets: BackfillTarget[] = [
    {
      testId: "test-1",
      originalFilename: "sample.pdf",
      normalizedFilename: "sample.pdf",
      workDir: "dir-1",
    },
  ];
  const dbRows: DbTestRow[] = [
    {
      id: "test-1",
      title: "Sample Paper",
      document_type: "paper",
      processing_status: "ready",
      pdf_filename: "sample.pdf",
    },
  ];

  const res = classifyTargets(targets, dbRows);
  assert.equal(res.toUpdate.length, 0);
  assert.equal(res.alreadySet.length, 1);
});

test("classifyTargets: 論文 (paper) 以外はスキップされる", () => {
  const targets: BackfillTarget[] = [
    {
      testId: "exam-1",
      originalFilename: "exam.pdf",
      normalizedFilename: "exam.pdf",
      workDir: "dir-exam",
    },
  ];
  const dbRows: DbTestRow[] = [
    {
      id: "exam-1",
      title: "Sample Past Exam",
      document_type: "past_exam",
      processing_status: "ready",
      pdf_filename: null,
    },
  ];

  const res = classifyTargets(targets, dbRows);
  assert.equal(res.toUpdate.length, 0);
  assert.equal(res.skippedNotPaper.length, 1);
});

test("classifyTargets: DB に存在しない ID は notFoundInDb に分類される", () => {
  const targets: BackfillTarget[] = [
    {
      testId: "test-unknown",
      originalFilename: "sample.pdf",
      normalizedFilename: "sample.pdf",
      workDir: "dir-unknown",
    },
  ];
  const dbRows: DbTestRow[] = [];

  const res = classifyTargets(targets, dbRows);
  assert.equal(res.toUpdate.length, 0);
  assert.equal(res.notFoundInDb.length, 1);
});

test("classifyTargets: DB 内に既に同一正規化ファイル名の別論文がある場合は衝突スキップされる", () => {
  const targets: BackfillTarget[] = [
    {
      testId: "test-2",
      originalFilename: "sample.pdf",
      normalizedFilename: "sample.pdf",
      workDir: "dir-2",
    },
  ];
  const dbRows: DbTestRow[] = [
    {
      id: "test-1",
      title: "Existing Paper",
      document_type: "paper",
      processing_status: "ready",
      pdf_filename: "SAMPLE.PDF",
    },
    {
      id: "test-2",
      title: "Duplicate Paper",
      document_type: "paper",
      processing_status: "ready",
      pdf_filename: null,
    },
  ];

  const res = classifyTargets(targets, dbRows);
  assert.equal(res.toUpdate.length, 0);
  assert.equal(res.skippedCollision.length, 1);
});

test("classifyTargets: 正規化ファイル名が空の場合はスキップされる", () => {
  const targets: BackfillTarget[] = [
    {
      testId: "test-empty",
      originalFilename: "   ",
      normalizedFilename: "",
      workDir: "dir-empty",
    },
  ];
  const dbRows: DbTestRow[] = [
    {
      id: "test-empty",
      title: "Empty Paper",
      document_type: "paper",
      processing_status: "ready",
      pdf_filename: null,
    },
  ];

  const res = classifyTargets(targets, dbRows);
  assert.equal(res.toUpdate.length, 0);
  assert.equal(res.skippedCollision.length, 1);
});

test("classifyTargets: state.json に対応が無い DB 論文を unmatchedDbPapers に検出する", () => {
  const targets: BackfillTarget[] = [];
  const dbRows: DbTestRow[] = [
    {
      id: "db-only",
      title: "Orphan Paper",
      document_type: "paper",
      processing_status: "ready",
      pdf_filename: null,
    },
  ];

  const res = classifyTargets(targets, dbRows);
  assert.equal(res.unmatchedDbPapers.length, 1);
  assert.equal(res.unmatchedDbPapers[0].id, "db-only");
});
