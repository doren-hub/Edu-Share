import { test } from "node:test";
import assert from "node:assert/strict";
import { isFinishedDownloadCandidate, isIncomingDownloadActive } from "./ui.ts";

test("isIncomingDownloadActive: 新規かサイズ増加だけ", () => {
  assert.equal(isIncomingDownloadActive(undefined, 100), true);
  assert.equal(isIncomingDownloadActive(100, 200), true);
  assert.equal(isIncomingDownloadActive(200, 200), false);
  assert.equal(isIncomingDownloadActive(200, 150), false);
});

test("isFinishedDownloadCandidate: 途中ファイルは使わず、動画は拡張子なしでも可", () => {
  assert.equal(
    isFinishedDownloadCandidate("abc.crdownload", ".mp4", { isVideoFile: true }),
    false,
  );
  assert.equal(
    isFinishedDownloadCandidate("clip.mp4", ".mp4", { isVideoFile: true }),
    true,
  );
  assert.equal(
    isFinishedDownloadCandidate("9f99400a-4536-43ec-8e70-a62d1e6f7cb0", ".mp4", { isVideoFile: true }),
    true,
  );
  assert.equal(
    isFinishedDownloadCandidate("note.pdf", ".mp4", { isVideoFile: false }),
    false,
  );
  assert.equal(
    isFinishedDownloadCandidate("paper.pdf", ".pdf", { isVideoFile: false }),
    true,
  );
});
