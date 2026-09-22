import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENERATION_START_GRACE_MS,
  HARVEST_RETRY_BASE_MS,
  HARVEST_RETRY_MAX_MS,
  STUDIO_EMPTY_UNMARK_MS,
  applyHarvestFailure,
  clearHarvestRetry,
  decideIncompleteStudioScan,
  harvestBackoffMs,
  isRetryCooling,
  retryUntilMs,
} from "./waiting.ts";

test("harvestBackoffMs: 失敗するほど間隔を空け、上限は 2 時間", () => {
  assert.equal(harvestBackoffMs(0), HARVEST_RETRY_BASE_MS);
  assert.equal(harvestBackoffMs(1), HARVEST_RETRY_BASE_MS * 3);
  assert.equal(harvestBackoffMs(2), HARVEST_RETRY_BASE_MS * 9);
  assert.equal(harvestBackoffMs(6), HARVEST_RETRY_MAX_MS);
  assert.equal(harvestBackoffMs(-1), HARVEST_RETRY_BASE_MS);
});

test("applyHarvestFailure: 次の再試行時刻を書き、成功したら消す", () => {
  const now = Date.parse("2026-09-22T05:30:00.000Z");
  const state = { harvestRetryAt: "", harvestFailures: 0, kickoffRetryAt: "" };
  const wait = applyHarvestFailure(state, now);
  assert.equal(wait, HARVEST_RETRY_BASE_MS);
  assert.equal(state.harvestFailures, 1);
  assert.equal(state.harvestRetryAt, new Date(now + wait).toISOString());
  assert.equal(isRetryCooling(state, now + 60_000), true);
  assert.equal(isRetryCooling(state, now + wait + 1), false);
  clearHarvestRetry(state);
  assert.equal(state.harvestFailures, 0);
  assert.equal(state.harvestRetryAt, "");
  assert.equal(isRetryCooling(state, now), false);
});

test("retryUntilMs: harvest と kickoff の遅い方を使う", () => {
  const now = Date.parse("2026-09-22T05:30:00.000Z");
  const state = {
    harvestRetryAt: new Date(now + 60_000).toISOString(),
    kickoffRetryAt: new Date(now + 180_000).toISOString(),
  };
  assert.equal(retryUntilMs(state, now), now + 180_000);
});

test("decideIncompleteStudioScan: 開始直後はカード無しでも開始を残す", () => {
  const now = Date.parse("2026-09-22T05:30:00.000Z");
  assert.equal(
    decideIncompleteStudioScan({
      generationStartedAt: new Date(now - 5 * 60_000).toISOString(),
      generating: false,
      now,
    }),
    "keep",
  );
  assert.equal(
    decideIncompleteStudioScan({
      generationStartedAt: new Date(now - GENERATION_START_GRACE_MS + 1).toISOString(),
      generating: false,
      now,
    }),
    "keep",
  );
});

test("decideIncompleteStudioScan: 20分超で空ならすぐ開き直さず、1時間超ならやり直し", () => {
  const now = Date.parse("2026-09-22T05:30:00.000Z");
  assert.equal(
    decideIncompleteStudioScan({
      generationStartedAt: new Date(now - 30 * 60_000).toISOString(),
      generating: false,
      now,
    }),
    "cooldown",
  );
  assert.equal(
    decideIncompleteStudioScan({
      generationStartedAt: new Date(now - 30 * 60_000).toISOString(),
      generating: true,
      now,
    }),
    "keep",
  );
  assert.equal(
    decideIncompleteStudioScan({
      generationStartedAt: new Date(now - STUDIO_EMPTY_UNMARK_MS - 1).toISOString(),
      generating: true,
      now,
    }),
    "unmark",
  );
  assert.equal(
    decideIncompleteStudioScan({
      generationStartedAt: "",
      generating: false,
      now,
    }),
    "unmark",
  );
});
