import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsLocalVideoFile, videoFileReady, ensureUploadableVideo, isRealVideoFile, isMp4FtypBuffer, isLikelyThumbUrl, isLikelyNonVideoArtifactUrl, extractVideoHintedUrls, rankVideoArtifactUrls, assembleVideoFragments, looksLikeVideoUrl, VIDEO_UPLOAD_MAX_BYTES } from "./video-file.ts";

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
    assert.equal(
      needsLocalVideoFile({
        paperDir: dir,
        videoMp4Path: "",
        completed: ["nlm-quiz"],
        notebooklmUrl: "https://notebook.google.com/notebook/x",
        waitingFor: "nlm-video",
      }),
      true,
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

test("isMp4FtypBuffer: PDF と ZIP は弾く", () => {
  const mp4 = Buffer.alloc(12, 0);
  mp4.write("ftyp", 4);
  assert.equal(isMp4FtypBuffer(mp4), true);
  assert.equal(isMp4FtypBuffer(Buffer.from("%PDF-1.4....")), false);
  assert.equal(isMp4FtypBuffer(Buffer.from("PK\u0003\u0004xxxxxx")), false);
  assert.equal(isMp4FtypBuffer(Buffer.from("short")), false);
});

test("rankVideoArtifactUrls: サムネを後回しにし googleusercontent を残す", () => {
  const thumb = "https://lh3.googleusercontent.com/a=s96-c";
  const media = "https://lh3.googleusercontent.com/video-bytes";
  const dl = "https://contribution.usercontent.google.com/download?c=abc";
  const fonts = "https://fonts.googleapis.com/css";
  const mp4 = "https://cdn.example/file.mp4";
  const ranked = rankVideoArtifactUrls([thumb, fonts, media, dl, mp4]);
  assert.equal(ranked[0], mp4);
  assert.ok(ranked.indexOf(media) < ranked.indexOf(dl));
  assert.equal(ranked.includes(thumb), false);
  assert.equal(ranked.includes(fonts), false);
  assert.equal(isLikelyThumbUrl(thumb), true);
  assert.equal(isLikelyThumbUrl(media), false);
});

test("isLikelyNonVideoArtifactUrl / extractVideoHintedUrls: スライド PDF を動画にしない", () => {
  const pdf = "https://x.example/deck.pdf";
  const mp4 = "https://storage.googleapis.com/x.mp4?token=1";
  assert.equal(isLikelyNonVideoArtifactUrl(pdf), true);
  assert.equal(isLikelyNonVideoArtifactUrl(mp4), false);
  const raw = JSON.stringify(["ARTIFACT_TYPE_VIDEO", mp4, "SLIDE", pdf]);
  assert.deepEqual(extractVideoHintedUrls(raw, [pdf, mp4]), [mp4]);
});

test("assembleVideoFragments: 映像 DASH を range 順に結合し音声は使わない", () => {
  const ftyp = fakeMp4(80_000);
  const moof = Buffer.alloc(50_000, 2);
  moof.write("moof", 4);
  const videoBase = "https://rr.googlevideo.com/videoplayback?mime=video%2Fmp4&itag=18";
  const audio = {
    url: "https://rr.googlevideo.com/videoplayback?mime=audio%2Fmp4&itag=140&range=0-500000",
    buf: fakeMp4(200_000),
  };
  const got = assembleVideoFragments([
    { url: `${videoBase}&range=80000-129999`, buf: moof },
    audio,
    { url: `${videoBase}&range=0-79999`, buf: ftyp },
  ]);
  assert.ok(got);
  assert.equal(got.length, 130_000);
  assert.equal(isMp4FtypBuffer(got.subarray(0, 12)), true);
  assert.equal(looksLikeVideoUrl(videoBase), true);
});
