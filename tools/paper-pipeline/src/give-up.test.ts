import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DISCONNECTS,
  MAX_FAIL_ROUNDS,
  emptyGiveUpTrack,
  holdWaiting,
  maxStageWaitMs,
  noteDisconnect,
  noteFailRound,
  noteWaiting,
} from "./give-up.ts";

test("noteWaiting: 同じ段階の待ちが上限を超えたらあきらめる", () => {
  const t = emptyGiveUpTrack();
  const hour = 60 * 60 * 1000;
  assert.equal(noteWaiting(t, "nlm-flashcards", 1_000, 3 * hour), false);
  assert.equal(noteWaiting(t, "nlm-flashcards", 1_000 + 2 * hour, 3 * hour), false);
  assert.equal(noteWaiting(t, "nlm-flashcards", 1_000 + 3 * hour + 1, 3 * hour), true);
});

test("noteWaiting: 段階が進んだら数え直す", () => {
  const t = emptyGiveUpTrack();
  const hour = 60 * 60 * 1000;
  noteWaiting(t, "nlm-video", 1_000, 3 * hour);
  assert.equal(noteWaiting(t, "nlm-flashcards", 1_000 + 4 * hour, 3 * hour), false);
  assert.equal(noteWaiting(t, "nlm-flashcards", 1_000 + 5 * hour, 3 * hour), false);
  assert.equal(noteWaiting(t, "nlm-flashcards", 1_000 + 8 * hour, 3 * hour), true);
});

test("holdWaiting: 利用量待ちの間は待ち時間に数えない", () => {
  const t = emptyGiveUpTrack();
  const hour = 60 * 60 * 1000;
  noteWaiting(t, "nlm-video", 1_000, 3 * hour);
  holdWaiting(t, 1_000 + 10 * hour);
  assert.equal(noteWaiting(t, "nlm-video", 1_000 + 12 * hour, 3 * hour), false);
  assert.equal(noteWaiting(t, "nlm-video", 1_000 + 13 * hour + 1, 3 * hour), true);
});

test("holdWaiting: 待ちが始まっていなければ何もしない", () => {
  const t = emptyGiveUpTrack();
  holdWaiting(t, 5_000);
  assert.equal(t.waitSince, 0);
});

test("noteFailRound: 上限の巡回数であきらめる", () => {
  const t = emptyGiveUpTrack();
  for (let i = 1; i < MAX_FAIL_ROUNDS; i++) assert.equal(noteFailRound(t), false);
  assert.equal(noteFailRound(t), true);
});

test("noteDisconnect: 切断が続いたらあきらめる", () => {
  const t = emptyGiveUpTrack();
  for (let i = 1; i < MAX_DISCONNECTS; i++) assert.equal(noteDisconnect(t), false);
  assert.equal(noteDisconnect(t), true);
});

test("maxStageWaitMs: 環境変数の分指定を使い、不正な値は既定に戻す", () => {
  assert.equal(maxStageWaitMs("30"), 30 * 60_000);
  assert.equal(maxStageWaitMs("abc"), 3 * 60 * 60 * 1000);
  assert.equal(maxStageWaitMs(undefined), 3 * 60 * 60 * 1000);
});
