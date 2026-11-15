import { fileHash } from "./download-files.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { AppConfig } from "./config.ts";
import { archivePaper, listArchive, renameArchive, restorePaper } from "./artifact-archive.ts";
import { emptyState, loadState, saveState, type PaperState } from "./state.ts";
import { listVideoRepairPdfs, listStudioFollowupPdfs, listEduMaterialRepairPdfs, listRawPasteRepairPdfs } from "./inbox.ts";
import { studioArtifactReady } from "./studio-select.ts";
import { needsLocalVideoFile } from "./video-file.ts";
import { missingEduUploads } from "./harvest.ts";
import { processOnePaper } from "./pipeline.ts";

function fixture(run: (f: { root: string; archive: string; state: PaperState; reload: () => PaperState }) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "artifact-archive-"));
  const paperDir = join(root, "work", "paper");
  const archive = join(root, "archive");
  mkdirSync(paperDir, { recursive: true }); mkdirSync(archive);
  const state = emptyState({ paperDir, filename: "paper.pdf", inboxPdfPath: join(paperDir, "paper.pdf") });
  Object.assign(state, { completed: ["nlm-video", "nlm-slides", "edu-materials", "done"],
    eduShareTestId: "test-paper", notebooklmUrl: "https://example.test/notebook",
    videoMp4Path: join(paperDir, "video.mp4"), slidePdfPath: join(paperDir, "slides.pdf"),
    quizCsvPath: join(paperDir, "quiz.csv"), vocabCsvPath: join(paperDir, "vocab.csv") });
  for (const name of ["video.mp4", "slides.pdf", "paper.pdf", "quiz.csv", "vocab.csv", "DONE"]) {
    writeFileSync(join(paperDir, name), name.repeat(100));
  }
  saveState(state);
  return Promise.resolve().then(() => run({ root, archive, state, reload: () => loadState(paperDir, state) }))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test("dry run leaves every local/archive file and state unchanged; explicit archive and restore round trip", () => fixture(({ archive, state, reload }) => {
  const before = readFileSync(join(state.paperDir, "state.json"), "utf8");
  const plan = archivePaper({ paperDir: state.paperDir, root: archive });
  assert.equal(plan.length, 3);
  assert.deepEqual(readdirSync(archive), []);
  assert.equal(readFileSync(join(state.paperDir, "state.json"), "utf8"), before);
  const copies: string[] = [];
  archivePaper({ paperDir: state.paperDir, root: archive, execute: true }, (src, dest, flags) => {
    assert.equal(reload().artifactArchive, undefined);
    for (const f of plan) assert.ok(existsSync(f.localPath));
    copies.push(String(src)); copyFileSync(src, dest, flags);
  });
  assert.equal(copies.length, 3);
  assert.equal(listArchive(state.paperDir)?.provider, "google-drive");
  assert.ok(Number.isFinite(Date.parse(listArchive(state.paperDir)!.archivedAt)));
  for (const f of Object.values(listArchive(state.paperDir)!.files)) {
    assert.equal(readFileSync(f.path).length, f.bytes);
    assert.equal(f.sha256, fileHash(f.path));
    assert.ok(!existsSync(f.localPath));
  }
  for (const name of ["state.json", "quiz.csv", "vocab.csv", "DONE"]) assert.ok(existsSync(join(state.paperDir, name)));
  assert.equal(restorePaper(state.paperDir).length, 3);
  for (const f of plan) assert.ok(!existsSync(f.localPath));
  restorePaper(state.paperDir, true, (src, dest, flags) => {
    assert.ok(reload().artifactArchive); copyFileSync(src, dest, flags);
  });
  assert.equal(reload().artifactArchive, undefined);
  for (const f of plan) assert.ok(existsSync(f.localPath));
}));

test("verification failure retains all originals and writes no record", () => fixture(({ state, archive, reload }) => {
  assert.throws(() => archivePaper({ paperDir: state.paperDir, root: archive, execute: true }, (_src, dest) => writeFileSync(dest, "bad")), /verification failed/);
  assert.equal(reload().artifactArchive, undefined);
  for (const name of ["video.mp4", "slides.pdf", "paper.pdf"]) assert.ok(existsSync(join(state.paperDir, name)));
}));

test("copy failure retains originals and state", () => fixture(({ state, archive, reload }) => {
  assert.throws(() => archivePaper({ paperDir: state.paperDir, root: archive, execute: true }, () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(reload().artifactArchive, undefined);
  assert.ok(existsSync(state.videoMp4Path));
}));

test("restore failure retains record and archive without publishing partial files", () => fixture(({ state, archive, reload }) => {
  archivePaper({ paperDir: state.paperDir, root: archive, execute: true });
  assert.throws(() => restorePaper(state.paperDir, true, (_src, dest) => writeFileSync(dest, "bad")), /size mismatch/);
  assert.ok(reload().artifactArchive);
  assert.ok(!existsSync(state.videoMp4Path));
  restorePaper(state.paperDir, true);
}));

test("archived DONE paper never opens archive paths or reopens DONE; unrecorded video still requires repair", () => fixture(async ({ state, archive, reload, root }) => {
  const work = join(root, "work");
  assert.equal(needsLocalVideoFile(state), true);
  assert.equal(listVideoRepairPdfs(work).length, 1);
  archivePaper({ paperDir: state.paperDir, root: archive, execute: true });
  // An unavailable archive must not be inspected by readiness/repair/list/process decisions.
  rmSync(archive, { recursive: true });
  const saved = reload();
  assert.equal(needsLocalVideoFile(saved), false);
  assert.equal(studioArtifactReady(saved, "nlm-video"), true);
  assert.equal(studioArtifactReady(saved, "nlm-slides"), true);
  assert.deepEqual(missingEduUploads(saved, ["nlm-video", "nlm-slides"]), []);
  // Also exercise scans when the original PDF happens to remain locally.
  writeFileSync(join(state.paperDir, state.filename), "pdf");
  assert.deepEqual(listVideoRepairPdfs(work), []);
  assert.deepEqual(listStudioFollowupPdfs(work, ["nlm-video", "nlm-slides"]), []);
  assert.deepEqual(listEduMaterialRepairPdfs(work, ["nlm-video", "nlm-slides"]), []);
  assert.deepEqual(listRawPasteRepairPdfs(work), []);
  assert.ok(listArchive(state.paperDir));
  const before = readFileSync(join(state.paperDir, "state.json"), "utf8");
  assert.equal(await processOnePaper({} as Page, {} as AppConfig, {
    filename: state.filename, absPath: join(state.paperDir, state.filename), stem: "paper", paperDir: state.paperDir,
  }), "skipped");
  assert.ok(existsSync(join(state.paperDir, "DONE")));
  assert.equal(readFileSync(join(state.paperDir, "state.json"), "utf8"), before);
}));

for (const reason of ["not-done", "not-uploaded", "give-up", "no-materials", "missing-root", "nested-root", "linked-source", "protected-source"] as const) {
  test(`unsafe archive rejected: ${reason}`, () => fixture(({ state, archive, root }) => {
    let destination = archive;
    if (reason === "not-done") rmSync(join(state.paperDir, "DONE"));
    if (reason === "not-uploaded") state.eduShareTestId = "";
    if (reason === "give-up") state.giveUp = { at: new Date().toISOString(), reason: "test" };
    if (reason === "no-materials") state.completed = ["done"];
    if (reason === "missing-root") destination = join(root, "missing");
    if (reason === "nested-root") { destination = join(state.paperDir, "archive"); mkdirSync(destination); }
    if (reason === "linked-source") { rmSync(state.videoMp4Path); symlinkSync(join(state.paperDir, "paper.pdf"), state.videoMp4Path); }
    if (reason === "protected-source") state.videoMp4Path = join(state.paperDir, "quiz.csv");
    saveState(state);
    assert.throws(() => archivePaper({ paperDir: state.paperDir, root: destination, execute: true }));
    assert.ok(existsSync(join(state.paperDir, "paper.pdf")));
    assert.equal(listArchive(state.paperDir), undefined);
  }));
}

test("restore refuses to overwrite local files and keeps metadata", () => fixture(({ state, archive, reload }) => {
  archivePaper({ paperDir: state.paperDir, root: archive, execute: true });
  writeFileSync(state.videoMp4Path, "new local data");
  assert.throws(() => restorePaper(state.paperDir, true), /already exists/);
  assert.equal(readFileSync(state.videoMp4Path, "utf8"), "new local data");
  assert.ok(reload().artifactArchive);
}));

test("malformed archive record cannot suppress missing video", () => fixture(({ state }) => {
  state.artifactArchive = { provider: "", archivedAt: "invalid", files: { video: { localPath: "a", path: "b", bytes: 1 } } };
  assert.equal(needsLocalVideoFile(state), true);
}));


function legacyArchive(state: PaperState, archive: string, reload: () => PaperState) {
  archivePaper({ paperDir: state.paperDir, root: archive, execute: true });
  const saved = reload();
  for (const [kind, f] of Object.entries(saved.artifactArchive!.files)) {
    const old = join(f.path, "..", `${kind}${kind === "video" ? ".mp4" : ".pdf"}`);
    if (old !== f.path) renameSync(f.path, old);
    f.path = old;
  }
  saveState(saved);
  return saved;
}

test("archive keeps PDF and compressed video names and explicitly reports retained original video", () => fixture(({ state, archive, reload }) => {
  state.videoMp4Path = join(state.paperDir, "video-upload.mp4");
  writeFileSync(state.videoMp4Path, "compressed video");
  saveState(state);
  const plan = archivePaper({ paperDir: state.paperDir, root: archive });
  assert.equal(plan.find((f) => f.kind === "pdf")!.path.split("/").pop(), "paper.pdf");
  const video = plan.find((f) => f.kind === "video")!;
  assert.equal(video.path.split("/").pop(), "video-upload.mp4");
  assert.deepEqual(video.retainedLocalPaths, [join(realpathSync(state.paperDir), "video.mp4")]);
  const executed = archivePaper({ paperDir: state.paperDir, root: archive, execute: true });
  assert.deepEqual(executed.find((f) => f.kind === "video")!.retainedLocalPaths, video.retainedLocalPaths);
  assert.ok(existsSync(join(state.paperDir, "video.mp4")));
  assert.ok(reload().artifactArchive!.files.video!.path.endsWith("/video-upload.mp4"));
  restorePaper(state.paperDir, true);
  assert.equal(readFileSync(state.videoMp4Path, "utf8"), "compressed video");
}));

test("legacy rename dry run changes nothing; execute updates names and record, then restores", () => fixture(({ state, archive, reload }) => {
  const saved = legacyArchive(state, archive, reload);
  const before = readFileSync(join(state.paperDir, "state.json"), "utf8");
  const plan = renameArchive(state.paperDir);
  assert.ok(plan.some((f) => f.from.endsWith("/pdf.pdf") && f.to.endsWith("/paper.pdf")));
  assert.equal(readFileSync(join(state.paperDir, "state.json"), "utf8"), before);
  assert.ok(existsSync(saved.artifactArchive!.files.pdf!.path));
  renameArchive(state.paperDir, true);
  assert.ok(listArchive(state.paperDir)!.files.pdf!.path.endsWith("/paper.pdf"));
  assert.ok(!existsSync(saved.artifactArchive!.files.pdf!.path));
  renameArchive(state.paperDir, true); // idempotent
  restorePaper(state.paperDir, true);
  assert.equal(readFileSync(join(state.paperDir, "paper.pdf"), "utf8"), "paper.pdf".repeat(100));
}));

for (const failure of ["collision", "missing", "duplicate-target"] as const) {
  test(`rename preflights entire paper without changing it: ${failure}`, () => fixture(({ state, archive, reload }) => {
    const saved = legacyArchive(state, archive, reload);
    const pdf = saved.artifactArchive!.files.pdf!;
    if (failure === "collision") writeFileSync(join(pdf.path, "..", "paper.pdf"), "existing");
    if (failure === "missing") rmSync(pdf.path);
    if (failure === "duplicate-target") {
      saved.artifactArchive!.files.video!.localPath = pdf.localPath;
      saveState(saved);
    }
    const before = readFileSync(join(state.paperDir, "state.json"), "utf8");
    for (const execute of [false, true]) assert.throws(() => renameArchive(state.paperDir, execute));
    assert.equal(readFileSync(join(state.paperDir, "state.json"), "utf8"), before);
    assert.ok(existsSync(saved.artifactArchive!.files.slides!.path));
    if (failure === "collision") assert.equal(readFileSync(join(pdf.path, "..", "paper.pdf"), "utf8"), "existing");
  }));
}

test("rename error rolls back earlier renames without publishing state", () => fixture(({ state, archive, reload }) => {
  state.videoMp4Path = join(state.paperDir, "video-upload.mp4");
  writeFileSync(state.videoMp4Path, "compressed"); saveState(state);
  const saved = legacyArchive(state, archive, reload);
  const before = readFileSync(join(state.paperDir, "state.json"), "utf8");
  let calls = 0;
  assert.throws(() => renameArchive(state.paperDir, true, (from, to) => {
    if (++calls === 2) throw new Error("rename failed");
    renameSync(from, to);
  }), /rename failed/);
  assert.equal(readFileSync(join(state.paperDir, "state.json"), "utf8"), before);
  for (const f of Object.values(saved.artifactArchive!.files)) assert.ok(existsSync(f.path));
  renameArchive(state.paperDir, true);
  restorePaper(state.paperDir, true);
}));

test("interrupted transaction can recover from its journal and finish renaming", () => fixture(({ state, archive, reload }) => {
  const saved = legacyArchive(state, archive, reload);
  const before = saved.artifactArchive!;
  const after = structuredClone(before);
  const pdf = after.files.pdf!;
  pdf.path = join(pdf.path, "..", "paper.pdf");
  writeFileSync(join(state.paperDir, ".artifact-archive-rename.json"), JSON.stringify({ before, after }));
  renameSync(before.files.pdf!.path, pdf.path);
  assert.throws(() => renameArchive(state.paperDir), /Interrupted/);
  renameArchive(state.paperDir, true);
  assert.deepEqual(reload().artifactArchive, after);
  assert.ok(!existsSync(join(state.paperDir, ".artifact-archive-rename.json")));
  restorePaper(state.paperDir, true);
}));


test("video through a directory alias is archived and never reported as retained", () => fixture(({ root, state, archive }) => {
  const alias = join(root, "paper-alias");
  symlinkSync(state.paperDir, alias);
  state.videoMp4Path = join(alias, "video.mp4");
  saveState(state);
  const plan = archivePaper({ paperDir: state.paperDir, root: archive });
  assert.equal(plan.find((f) => f.kind === "video")!.retainedLocalPaths, undefined);
  const executed = archivePaper({ paperDir: state.paperDir, root: archive, execute: true });
  assert.equal(executed.find((f) => f.kind === "video")!.retainedLocalPaths, undefined);
  assert.ok(!existsSync(state.videoMp4Path));
  restorePaper(state.paperDir, true);
  assert.ok(existsSync(state.videoMp4Path));
}));

test("compressed video without an original never reports a retained file", () => fixture(({ state, archive }) => {
  state.videoMp4Path = join(state.paperDir, "video-upload.mp4");
  writeFileSync(state.videoMp4Path, "compressed");
  rmSync(join(state.paperDir, "video.mp4"));
  saveState(state);
  assert.equal(archivePaper({ paperDir: state.paperDir, root: archive }).find((f) => f.kind === "video")!.retainedLocalPaths, undefined);
  assert.equal(archivePaper({ paperDir: state.paperDir, root: archive, execute: true }).find((f) => f.kind === "video")!.retainedLocalPaths, undefined);
}));
