import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNotebookQuotaStatus, EXIT_QUOTA, EXIT_QUOTA_UNAVAILABLE } from "./quota-check.ts";
import type { NotebookQuotaConfig } from "./notebook-quota.ts";

const sampleUsage = {
  providers: [
    {
      key: "gemini",
      metrics: [
        {
          label: "Gemini Notebook (短期枠)",
          used_percent: 50,
          remaining_percent: 50,
          reset_at: "2026-11-01 20:00",
        },
        {
          label: "Gemini Notebook (週枠)",
          used_percent: 60,
          remaining_percent: 40,
          reset_at: "2026-11-05 12:00",
        },
      ],
    },
  ],
};

const makeConfig = (over: Partial<NotebookQuotaConfig> = {}): NotebookQuotaConfig => ({
  ignoreNotebookQuota: false,
  notebookQuotaUrls: ["http://mock/usage"],
  notebookQuotaFiles: [],
  notebookShortStopPercent: 85,
  notebookWeeklyStopPercent: 100,
  ...over,
});

test("checkNotebookQuotaStatus: ignoreNotebookQuota が真のときは利用可能 (0)", async () => {
  const cfg = makeConfig({ ignoreNotebookQuota: true });
  const res = await checkNotebookQuotaStatus(cfg);
  assert.equal(res.exitCode, 0);
  assert.equal(res.kind, "available");
  assert.match(res.message, /ignoreNotebookQuota/);
});

test("checkNotebookQuotaStatus: 利用量が読めないときは利用不可 (12)", async () => {
  const cfg = makeConfig();
  const res = await checkNotebookQuotaStatus(cfg, {
    fetchJson: async () => null,
    readFile: () => null,
  });
  assert.equal(res.exitCode, EXIT_QUOTA_UNAVAILABLE);
  assert.equal(res.kind, "unavailable");
  assert.match(res.message, /読めません/);
});

test("checkNotebookQuotaStatus: 利用枠に余裕があるときは利用可能 (0)", async () => {
  const cfg = makeConfig();
  const res = await checkNotebookQuotaStatus(cfg, {
    fetchJson: async () => sampleUsage,
    now: () => Date.parse("2026-11-01T10:00:00+09:00"),
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.kind, "available");
  assert.match(res.message, /空いています/);
  assert.match(res.message, /短期: 50%/);
  assert.match(res.message, /週: 60%/);
});

test("checkNotebookQuotaStatus: 短期枠がしきい値超のときは一時停止 (11)", async () => {
  const highShortUsage = {
    providers: [
      {
        metrics: [
          {
            label: "Gemini Notebook (短期枠)",
            used_percent: 90,
            reset_at: "2026-11-01 20:00",
          },
        ],
      },
    ],
  };
  const cfg = makeConfig({ notebookShortStopPercent: 85 });
  const res = await checkNotebookQuotaStatus(cfg, {
    fetchJson: async () => highShortUsage,
    now: () => Date.parse("2026-11-01T10:00:00+09:00"),
  });
  assert.equal(res.exitCode, EXIT_QUOTA);
  assert.equal(res.kind, "paused");
  assert.match(res.message, /短期枠が 90%（しきい値 85% 超）/);
});

test("checkNotebookQuotaStatus: 週枠が100%に達したときは一時停止 (11)", async () => {
  const maxWeeklyUsage = {
    providers: [
      {
        metrics: [
          {
            label: "Gemini Notebook (週枠)",
            used_percent: 100,
            reset_at: "2026-11-05 12:00",
          },
        ],
      },
    ],
  };
  const cfg = makeConfig();
  const res = await checkNotebookQuotaStatus(cfg, {
    fetchJson: async () => maxWeeklyUsage,
    now: () => Date.parse("2026-11-01T10:00:00+09:00"),
  });
  assert.equal(res.exitCode, EXIT_QUOTA);
  assert.equal(res.kind, "paused");
  assert.match(res.message, /週枠が 100%/);
});

test("checkNotebookQuotaStatus: リセット時刻を過ぎていれば利用可能 (0)", async () => {
  const highShortUsage = {
    providers: [
      {
        metrics: [
          {
            label: "Gemini Notebook (短期枠)",
            used_percent: 90,
            reset_at: "2026-11-01 20:00",
          },
        ],
      },
    ],
  };
  const cfg = makeConfig();
  const res = await checkNotebookQuotaStatus(cfg, {
    fetchJson: async () => highShortUsage,
    // 20:00 を過ぎた 20:01
    now: () => Date.parse("2026-11-01T20:01:00+09:00"),
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.kind, "available");
});
