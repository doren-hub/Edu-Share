import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsLocalVideoFile, videoFileReady, ensureUploadableVideo, isRealVideoFile, VIDEO_UPLOAD_MAX_BYTES } from "./video-file.ts";

function fakeMp4(size: number): Buffer {
  const b = Buffer.alloc(size, 1);
  b.writeUInt32BE(size, 0);
  b.write("ftyp", 4);
  return b;
}

test("videoFileReady: 小さいファイルと PDF は未完了", () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-video-"));
  try {
    const p = join(dir, "video.mp4");
    writeFileSync(p, "tiny");
    assert.equal(videoFileReady(dir, p), false);
    writeFileSync(p, Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(120_000, 1)]));
    assert.equal(isRealVideoFile(p), false);
    assert.equal(videoFileReady(dir, p), false);
    writeFileSync(p, fakeMp4(120_000));
    assert.equal(isRealVideoFile(p), true);
    assert.equal(videoFileReady(dir, p), true);
    assert.equal(videoFileReady(dir, ""), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("needsLocalVideoFile: 生成済みで MP4 が無いときだけ", () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-need-vid-"));
  try {
    assert.equal(
      needsLocalVideoFile({
        paperDir: dir,
        videoMp4Path: "",
        completed: ["nlm-video"],
        notebooklmUrl: "https://notebook.google.com/notebook/x",
      }),
      true,
    );
    assert.equal(
      needsLocalVideoFile({
        paperDir: dir,
        videoMp4Path: "",
        completed: ["nlm-quiz"],
        notebooklmUrl: "https://notebook.google.com/notebook/x",
      }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureUploadableVideo: 上限以下はそのまま返す", () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-video-small-"));
  try {
    const p = join(dir, "video.mp4");
    writeFileSync(p, fakeMp4(120_000));
    assert.equal(ensureUploadableVideo(p), p);
    assert.ok(VIDEO_UPLOAD_MAX_BYTES < 50 * 1024 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
