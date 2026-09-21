import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paperHasNotebookLmSlidePath,
  paperHasNotebookLmVideoPath,
  paperNotebookLmMaterialPresence,
  paperNotebookLmMaterialsComplete,
  paperNotebookLmMissingLabels,
  toPaperBrowseListRow,
} from "./paper-notebooklm-materials.ts";

function mc(i: number) {
  return {
    id: `q${i}`,
    type: "multiple_choice" as const,
    prompt: `Q${i}`,
    options: ["a", "b", "c"],
    correctIndex: 0,
  };
}

function vocabEssay(i: number) {
  return {
    id: `v${i}`,
    type: "essay" as const,
    prompt: `term ${i}`,
    referenceAnswer: `def ${i}`,
  };
}

const quiz3 = [mc(1), mc(2), mc(3)];
const vocab3 = [vocabEssay(1), vocabEssay(2), vocabEssay(3)];
const slide = "user/test-notebooklm-slide.pdf";
const video = "user/test-notebooklm-video.mp4";

test("path: 本PDFや空はスライド／動画とみなさない", () => {
  assert.equal(paperHasNotebookLmSlidePath(null), false);
  assert.equal(paperHasNotebookLmSlidePath("user/testid.pdf"), false);
  assert.equal(paperHasNotebookLmSlidePath("  "), false);
  assert.equal(paperHasNotebookLmSlidePath(slide), true);
  assert.equal(paperHasNotebookLmVideoPath("user/test.mp4"), false);
  assert.equal(paperHasNotebookLmVideoPath(video), true);
});

test("complete: 4点が揃って初めて受験可能", () => {
  const full = {
    notebooklm_questions_json: quiz3,
    notebooklm_vocab_questions_json: vocab3,
    notebooklm_slide_pdf_storage_path: slide,
    notebooklm_video_mp4_storage_path: video,
  };
  assert.equal(paperNotebookLmMaterialsComplete(full), true);
  assert.deepEqual(paperNotebookLmMissingLabels(full), []);
});

test("incomplete: スライド・動画パスが無いときは受験可能にしない", () => {
  const row = {
    notebooklm_questions_json: quiz3,
    notebooklm_vocab_questions_json: vocab3,
    notebooklm_slide_pdf_storage_path: null,
    notebooklm_video_mp4_storage_path: null,
  };
  assert.equal(paperNotebookLmMaterialsComplete(row), false);
  assert.deepEqual(
    paperNotebookLmMissingLabels(row).map((x) => x.label),
    ["スライド", "動画"],
  );
});

test("incomplete: 空配列や1問だけでは CSV 揃いとみなさない", () => {
  const row = {
    notebooklm_questions_json: [mc(1)],
    notebooklm_vocab_questions_json: [],
    notebooklm_slide_pdf_storage_path: slide,
    notebooklm_video_mp4_storage_path: video,
  };
  const p = paperNotebookLmMaterialPresence(row);
  assert.equal(p.quiz, false);
  assert.equal(p.vocab, false);
  assert.equal(paperNotebookLmMaterialsComplete(row), false);
});

test("json string: 文字列で来てもプールとして読める", () => {
  const row = {
    notebooklm_questions_json: JSON.stringify(quiz3),
    notebooklm_vocab_questions_json: JSON.stringify(vocab3),
    notebooklm_slide_pdf_storage_path: slide,
    notebooklm_video_mp4_storage_path: video,
  };
  assert.equal(paperNotebookLmMaterialsComplete(row), true);
});

test("list flags: 事前計算した boolean を優先し JSON は不要", () => {
  assert.equal(
    paperNotebookLmMaterialsComplete({
      notebooklm_has_quiz_csv: true,
      notebooklm_has_vocab_csv: true,
      notebooklm_slide_pdf_storage_path: slide,
      notebooklm_video_mp4_storage_path: video,
    }),
    true,
  );
  assert.equal(
    paperNotebookLmMaterialPresence({
      notebooklm_has_quiz_csv: false,
      notebooklm_questions_json: quiz3,
      notebooklm_slide_pdf_storage_path: slide,
      notebooklm_video_mp4_storage_path: video,
    }).quiz,
    false,
  );
});

test("toPaperBrowseListRow: JSON スライス3件でもフラグを立てる", () => {
  const out = toPaperBrowseListRow({
    id: "1",
    title: "t",
    nq0: quiz3[0],
    nq1: quiz3[1],
    nq2: quiz3[2],
    nv0: vocab3[0],
    nv1: vocab3[1],
    nv2: vocab3[2],
    notebooklm_slide_pdf_storage_path: slide,
  });
  assert.equal(out.notebooklm_has_quiz_csv, true);
  assert.equal(out.notebooklm_has_vocab_csv, true);
  assert.equal("nq0" in out, false);
  assert.equal("nv2" in out, false);
});

test("toPaperBrowseListRow: JSON を落としてフラグだけ残す", () => {
  const out = toPaperBrowseListRow({
    id: "1",
    title: "t",
    notebooklm_questions_json: quiz3,
    notebooklm_vocab_questions_json: vocab3,
    notebooklm_slide_pdf_storage_path: slide,
    pdf_storage_path: "u/1.pdf",
    uploaded_by: "u",
  });
  assert.equal(out.notebooklm_has_quiz_csv, true);
  assert.equal(out.notebooklm_has_vocab_csv, true);
  assert.equal("notebooklm_questions_json" in out, false);
  assert.equal("pdf_storage_path" in out, false);
  assert.equal("uploaded_by" in out, false);
  assert.equal(out.title, "t");
});
