import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEduMaterialRepairPdfs, listExistingWorkPapers, listInboxPdfs, listRawPasteRepairPdfs, listVideoRepairPdfs, mergeInboxAndVideoRepair, existingWorkPapersExcept } from "./inbox.ts";
import { STUDIO_STAGES } from "./state.ts";

test("listInboxPdfs: 変更日が古い順（名前順ではない）", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-inbox-"));
  const inbox = join(root, "inbox");
  const work = join(root, "work");
  mkdirSync(inbox);
  mkdirSync(work);
  try {
    const older = join(inbox, "z-old.pdf");
    const newer = join(inbox, "a-new.pdf");
    writeFileSync(older, "old");
    writeFileSync(newer, "new");
    const now = Date.now() / 1000;
    utimesSync(older, now - 120, now - 120);
    utimesSync(newer, now - 10, now - 10);
    assert.deepEqual(
      listInboxPdfs(inbox, work).map((p) => p.filename),
      ["z-old.pdf", "a-new.pdf"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listVideoRepairPdfs: MP4 が無い完了論文だけ", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-repair-"));
  const work = join(root, "work");
  const paperDir = join(work, "0709.2257v2");
  mkdirSync(paperDir, { recursive: true });
  mkdirSync(join(root, "empty-inbox"));
  try {
    writeFileSync(join(paperDir, "0709.2257v2.pdf"), "pdf");
    writeFileSync(
      join(paperDir, "state.json"),
      JSON.stringify({
        filename: "0709.2257v2.pdf",
        inboxPdfPath: join(paperDir, "0709.2257v2.pdf"),
        paperDir,
        completed: ["nlm-video", "done"],
        notebooklmUrl: "https://notebook.google.com/notebook/abcd",
        videoMp4Path: "",
      }),
    );
    const found = listVideoRepairPdfs(work);
    assert.deepEqual(
      found.map((p) => p.filename),
      ["0709.2257v2.pdf"],
    );
    const inbox = listInboxPdfs(join(root, "empty-inbox"), work);
    assert.deepEqual(mergeInboxAndVideoRepair(inbox, found).map((p) => p.filename), [
      "0709.2257v2.pdf",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listRawPasteRepairPdfs: Files 行が無い／加工済みの完了論文だけ", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-paste-repair-"));
  const work = join(root, "work");
  const bad = join(work, "2307.09009v3");
  const good = join(work, "2601.15300v1");
  mkdirSync(bad, { recursive: true });
  mkdirSync(good, { recursive: true });
  try {
    writeFileSync(join(bad, "2307.09009v3.pdf"), "pdf");
    writeFileSync(join(good, "2601.15300v1.pdf"), "pdf");
    writeFileSync(
      join(bad, "state.json"),
      JSON.stringify({
        filename: "2307.09009v3.pdf",
        inboxPdfPath: join(bad, "2307.09009v3.pdf"),
        paperDir: bad,
        completed: ["sci-meta", "done"],
        eduShareTestUrl: "http://localhost:3000/tests/bad",
        filesPaste: "The First Law of Robotics Revisited\n2024⋅DOI⋅A. K. Dewdney",
      }),
    );
    writeFileSync(
      join(good, "state.json"),
      JSON.stringify({
        filename: "2601.15300v1.pdf",
        inboxPdfPath: join(good, "2601.15300v1.pdf"),
        paperDir: good,
        completed: ["sci-meta", "done"],
        eduShareTestUrl: "http://localhost:3000/tests/good",
        filesPaste:
          "2601.15300v1.pdf\nA title\n2026⋅Weiwei Wang\narXiv\nPDF UPLOAD\nUploaded on 20 Sep 2026",
      }),
    );
    writeFileSync(join(bad, "DONE"), "ok\n");
    writeFileSync(join(good, "DONE"), "ok\n");
    assert.deepEqual(
      listRawPasteRepairPdfs(work).map((p) => p.filename),
      ["2307.09009v3.pdf"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listEduMaterialRepairPdfs: 完了済みでも未反映の生成物がある論文だけ", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-edu-repair-"));
  const work = join(root, "work");
  const pending = join(work, "2601.18699v2");
  const done = join(work, "2603.03111v1");
  mkdirSync(pending, { recursive: true });
  mkdirSync(done, { recursive: true });
  try {
    writeFileSync(join(pending, "2601.18699v2.pdf"), "pdf");
    writeFileSync(join(pending, "quiz.csv"), "question,answer\nWhat is it?,A longer fact.\n");
    writeFileSync(join(pending, "DONE"), "ok\n");
    writeFileSync(
      join(pending, "state.json"),
      JSON.stringify({
        filename: "2601.18699v2.pdf",
        inboxPdfPath: join(pending, "2601.18699v2.pdf"),
        paperDir: pending,
        completed: ["nlm-quiz", "edu-upload", "done"],
        eduShareTestId: "aaa",
        eduShareTestUrl: "http://localhost:3000/tests/aaa",
        quizCsvPath: join(pending, "quiz.csv"),
        eduUploaded: [],
      }),
    );
    writeFileSync(join(done, "2603.03111v1.pdf"), "pdf");
    writeFileSync(join(done, "quiz.csv"), "question,answer\nWhat is it?,A longer fact.\n");
    writeFileSync(join(done, "DONE"), "ok\n");
    writeFileSync(
      join(done, "state.json"),
      JSON.stringify({
        filename: "2603.03111v1.pdf",
        inboxPdfPath: join(done, "2603.03111v1.pdf"),
        paperDir: done,
        completed: ["nlm-quiz", "edu-upload", "done"],
        eduShareTestId: "bbb",
        eduShareTestUrl: "http://localhost:3000/tests/bbb",
        quizCsvPath: join(done, "quiz.csv"),
        eduUploaded: ["nlm-quiz"],
      }),
    );
    assert.deepEqual(
      listEduMaterialRepairPdfs(work, STUDIO_STAGES).map((p) => p.filename),
      ["2601.18699v2.pdf"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listExistingWorkPapers: work 内の PDF 名で既存判定する", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-work-exist-"));
  const work = join(root, "work");
  const hawking = join(work, "hawking");
  const other = join(work, "2601.04170v1");
  mkdirSync(hawking, { recursive: true });
  mkdirSync(other, { recursive: true });
  try {
    writeFileSync(join(hawking, "hawking.pdf"), "pdf");
    writeFileSync(
      join(hawking, "state.json"),
      JSON.stringify({
        filename: "hawking.pdf",
        inboxPdfPath: join(hawking, "hawking.pdf"),
        paperDir: hawking,
        title: "Particle Creation by Black Holes",
        doi: "10.1007/example",
        eduShareTestId: "abc",
        eduShareTestUrl: "http://localhost:3000/tests/abc",
      }),
    );
    writeFileSync(join(other, "2601.04170v1.pdf"), "pdf");
    writeFileSync(
      join(other, "state.json"),
      JSON.stringify({
        filename: "2601.04170v1.pdf",
        inboxPdfPath: join(other, "2601.04170v1.pdf"),
        paperDir: other,
      }),
    );
    const all = listExistingWorkPapers(work);
    assert.equal(all.filter((p) => p.filename === "hawking.pdf").length, 1);
    assert.equal(
      existingWorkPapersExcept(work, hawking).some((p) => p.filename === "hawking.pdf"),
      false,
    );
    assert.ok(
      existingWorkPapersExcept(work, other).some((p) => p.filename === "hawking.pdf"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});