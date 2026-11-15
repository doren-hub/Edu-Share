import { copyIfReady } from "./ui.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupDownloads } from "./download-cleanup.ts";
import { fileHash, importDownload } from "./download-files.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "downloads-test-"));
  const profile = join(root, "profile");
  const downloads = join(profile, "playwright-downloads");
  const work = join(root, "work");
  const paper = join(work, "paper");
  mkdirSync(downloads, { recursive: true }); mkdirSync(paper, { recursive: true });
  writeFileSync(join(paper, "state.json"), "{}");
  return { root, profile, downloads, work, paper, now: Date.now() + 172_800_000 };
}

test("verified import deletes dedicated source; failed copy or verification preserves it", () => {
  const f = fixture();
  try {
    const src = join(f.downloads, "title.mp4"), dest = join(f.paper, "video.mp4");
    writeFileSync(src, "video");
    importDownload(src, dest, f.downloads);
    assert.equal(existsSync(src), false); assert.equal(readFileSync(dest, "utf8"), "video");
    writeFileSync(src, "video");
    assert.throws(() => importDownload(src, dest, f.downloads, () => { throw new Error("copy failed"); }));
    assert.equal(existsSync(src), true);
    assert.throws(() => importDownload(src, dest, f.downloads, (_s, d) => writeFileSync(d, "wrong")));
    assert.equal(existsSync(src), true);
    assert.throws(() => importDownload(src, dest, f.downloads, (s, d) => {
      copyFileSync(s, d); writeFileSync(s, "changed");
    }));
    assert.equal(existsSync(src), true);
    importDownload(src, src, f.downloads); assert.equal(existsSync(src), true);
    const outside = join(f.profile, "outside.mp4"); writeFileSync(outside, "outside");
    importDownload(outside, dest, f.downloads); assert.equal(existsSync(outside), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("dry run and execute use hashes, retain unknowns and protect profile files and links", () => {
  const f = fixture();
  try {
    const content = "same video";
    writeFileSync(join(f.paper, "video.mp4"), content);
    for (const name of ["title.mp4", "active.mp4.crdownload", "active.mp4"]) writeFileSync(join(f.downloads, name), content);
    writeFileSync(join(f.downloads, "unknown.mp4"), "diff video"); // same byte length
    writeFileSync(join(f.profile, "Preferences"), content);
    symlinkSync(join(f.profile, "Preferences"), join(f.downloads, "link.mp4"));
    const dry = cleanupDownloads(f);
    assert.equal(dry.eligibleBytes, Buffer.byteLength(content)); assert.equal(dry.deletedBytes, 0);
    assert.equal(existsSync(join(f.downloads, "title.mp4")), true);
    assert.throws(() => cleanupDownloads({ ...f, execute: true }), /Stop the pipeline/);
    const result = cleanupDownloads({ ...f, execute: true, pipelineStopped: true });
    assert.equal(result.deletedBytes, Buffer.byteLength(content));
    assert.equal(existsSync(join(f.downloads, "title.mp4")), false);
    for (const name of ["unknown.mp4", "active.mp4.crdownload", "active.mp4", "link.mp4"]) assert.equal(existsSync(join(f.downloads, name)), true);
    assert.equal(readFileSync(join(f.profile, "Preferences"), "utf8"), content);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("archive hashes work offline; legacy size-only records never delete an unrelated download", () => {
  const f = fixture();
  try {
    const src = join(f.downloads, "archived.mp4"); writeFileSync(src, "archived");
    const record = { localPath: join(f.paper, "video.mp4"), path: join(f.root, "missing-archive", "video.mp4"), bytes: 8, sha256: fileHash(src) };
    const state = { artifactArchive: { provider: "offline", archivedAt: new Date().toISOString(), files: { video: record } } };
    writeFileSync(join(f.paper, "state.json"), JSON.stringify(state));
    assert.equal(cleanupDownloads(f).eligibleBytes, 8);
    const { sha256: _hash, ...legacy } = record;
    state.artifactArchive.files.video = { ...legacy, sha256: "" };
    writeFileSync(join(f.paper, "state.json"), JSON.stringify(state));
    assert.equal(cleanupDownloads({ ...f, execute: true, pipelineStopped: true }).deletedBytes, 0);
    assert.equal(existsSync(src), true);
    state.artifactArchive.files.video = record;
    writeFileSync(join(f.paper, "state.json"), JSON.stringify(state));
    assert.equal(cleanupDownloads({ ...f, execute: true, pipelineStopped: true }).deletedBytes, 8);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("recent downloads, active Chrome, linked directories and linked state fail safe", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.paper, "video.mp4"), "same"); writeFileSync(join(f.downloads, "new.mp4"), "same");
    assert.equal(cleanupDownloads({ ...f, now: Date.now() }).eligibleBytes, 0);
    symlinkSync("nonexistent-host-pid", join(f.profile, "SingletonLock"));
    assert.throws(() => cleanupDownloads(f), /in use/);
    unlinkSync(join(f.profile, "SingletonLock"));
    rmSync(join(f.paper, "state.json")); symlinkSync(join(f.profile, "Preferences"), join(f.paper, "state.json"));
    assert.equal(cleanupDownloads(f).eligibleBytes, 0);
    rmSync(f.downloads, { recursive: true }); symlinkSync(f.paper, f.downloads);
    assert.throws(() => cleanupDownloads(f), /unlinked directory/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test("UI import validates video before deleting source and preserves prior destination on failure", () => {
  const f = fixture();
  try {
    const src = join(f.downloads, "title.mp4"), dest = join(f.paper, "video.mp4");
    writeFileSync(src, Buffer.alloc(120_000, 1));
    writeFileSync(dest, "previous artifact");
    assert.equal(copyIfReady(src, dest, 1000, f.downloads), false);
    assert.equal(existsSync(src), true);
    assert.equal(readFileSync(dest, "utf8"), "previous artifact");
    const video = Buffer.alloc(120_000, 1); video.write("ftyp", 4);
    writeFileSync(src, video);
    assert.equal(copyIfReady(src, dest, 1000, f.downloads), true);
    assert.equal(existsSync(src), false);
    assert.deepEqual(readFileSync(dest), video);
    const missingDest = join(f.root, "missing", "video.mp4");
    writeFileSync(src, video);
    assert.equal(copyIfReady(src, missingDest, 1000, f.downloads), false);
    assert.equal(existsSync(src), true);
    // Directory aliases for the same file must never remove the destination.
    const alias = join(f.root, "alias"); symlinkSync(f.downloads, alias);
    assert.equal(copyIfReady(src, join(alias, "title.mp4"), 1000, f.downloads), true);
    assert.equal(existsSync(src), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
