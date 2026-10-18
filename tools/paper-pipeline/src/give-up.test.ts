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

test("打ち切りは再読込でもスキップし、選んだ論文の明示的な再試行だけ解除する", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { emptyState, loadState } = await import("./state.ts");
  const { persistGiveUp, prepareGivenUp } = await import("./give-up.ts");
  const root = mkdtempSync(join(tmpdir(), "give-up-restart-"));
  try {
    const make = (name: string) => emptyState({ filename: `${name}.pdf`, inboxPdfPath: join(root, `${name}.pdf`), paperDir: join(root, name) });
    const a = make("a");
    const b = make("b");
    a.completed = ["nlm-create"];
    persistGiveUp(a, "失敗上限", 1234);
    persistGiveUp(b, "待ち上限", 2345);
    const reload = (state: typeof a) => loadState(state.paperDir, make(state.filename.slice(0, -4)));
    let workers = 0;
    const runSelected = (selected: typeof a[], retry: boolean) => {
      for (const state of selected.map(reload)) {
        if (!prepareGivenUp(state, retry)) workers++;
      }
    };
    runSelected([a, b], false);
    assert.equal(workers, 0);
    assert.equal(reload(a).giveUp?.reason, "失敗上限");
    runSelected([a], true);
    assert.equal(workers, 1);
    assert.equal(reload(a).giveUp, undefined);
    assert.deepEqual(reload(a).completed, ["nlm-create"]);
    assert.ok(reload(b).giveUp);
    runSelected([a, b], true);
    assert.equal(workers, 3);
    assert.equal(reload(b).giveUp, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
