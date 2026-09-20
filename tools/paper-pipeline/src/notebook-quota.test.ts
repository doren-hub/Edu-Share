import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractNotebookQuota,
  formatQuotaPause,
  loadNotebookQuota,
  notebookGenerationPause,
  parseResetAtJst,
  waitUntilNotebookQuotaAllows,
  type NotebookQuotaConfig,
} from "./notebook-quota.ts";

const usageLatest = {
  providers: [
    {
      key: "gemini",
      metrics: [
        {
          label: "Gemini アプリ (週枠)",
          used_percent: 100,
          remaining_percent: 0,
          reset_at: "2026-09-24 11:57",
        },
        {
          label: "Gemini Notebook (短期枠)",
          used_percent: 90,
          remaining_percent: 10,
          reset_at: "2026-09-20 20:53",
        },
        {
          label: "Gemini Notebook (週枠)",
          used_percent: 35.2,
          remaining_percent: 64.8,
          reset_at: "2026-09-24 12:53",
        },
      ],
    },
  ],
};

const cfg = (over: Partial<NotebookQuotaConfig> = {}): NotebookQuotaConfig => ({
  ignoreNotebookQuota: false,
  notebookQuotaUrls: [],
  notebookQuotaFiles: [],
  notebookShortStopPercent: 85,
  notebookWeeklyStopPercent: 100,
  ...over,
});

test("parseResetAtJst: 利用量ボードの JST 表記", () => {
  const n = parseResetAtJst("2026-09-20 20:53");
  assert.equal(n, Date.parse("2026-09-20T20:53:00+09:00"));
});

test("extractNotebookQuota: Gemini アプリ枠と混ぜず Notebook だけ取る", () => {
  const q = extractNotebookQuota(usageLatest, "board");
  assert.ok(q);
  assert.equal(q.shortUsed, 90);
  assert.equal(q.weeklyUsed, 35.2);
  assert.equal(q.shortResetLabel, "2026-09-20 20:53");
  assert.equal(q.weeklyResetLabel, "2026-09-24 12:53");
  assert.equal(q.source, "board");
});

test("extractNotebookQuota: notebooklm-cache.json", () => {
  const q = extractNotebookQuota(
    {
      used_percent: 100,
      remaining_percent: 0,
      reset_at: "2026-09-24 12:53",
      short_term_used_percent: 97.5,
      short_term_remaining_percent: 2.5,
      short_term_reset_at: "2026-09-20 20:53",
    },
    "cache",
  );
  assert.ok(q);
  assert.equal(q.shortUsed, 97.5);
  assert.equal(q.weeklyUsed, 100);
});

test("notebookGenerationPause: 短期 85% ちょうどは止らない", () => {
  const now = Date.parse("2026-09-20T18:50:00+09:00");
  const pause = notebookGenerationPause(
    {
      shortUsed: 85,
      shortRemaining: 15,
      shortResetAt: Date.parse("2026-09-20T20:53:00+09:00"),
      shortResetLabel: "2026-09-20 20:53",
      weeklyUsed: 35,
      weeklyRemaining: 65,
      weeklyResetAt: Date.parse("2026-09-24T12:53:00+09:00"),
      weeklyResetLabel: "2026-09-24 12:53",
      source: "t",
    },
    now,
  );
  assert.equal(pause, null);
});

test("notebookGenerationPause: 短期 85% 超はリセットまで止める", () => {
  const now = Date.parse("2026-09-20T18:50:00+09:00");
  const pause = notebookGenerationPause(
    extractNotebookQuota(usageLatest, "board"),
    now,
  );
  assert.ok(pause);
  assert.equal(pause.reason, "short");
  assert.equal(pause.used, 90);
  assert.equal(pause.untilLabel, "2026-09-20 20:53");
});

test("notebookGenerationPause: 週枠 100% は週リセットを優先", () => {
  const now = Date.parse("2026-09-20T18:50:00+09:00");
  const pause = notebookGenerationPause(
    extractNotebookQuota(
      {
        used_percent: 100,
        remaining_percent: 0,
        reset_at: "2026-09-24 12:53",
        short_term_used_percent: 10,
        short_term_remaining_percent: 90,
        short_term_reset_at: "2026-09-20 20:53",
      },
      "cache",
    ),
    now,
  );
  assert.ok(pause);
  assert.equal(pause.reason, "weekly");
  assert.equal(pause.untilLabel, "2026-09-24 12:53");
  assert.match(formatQuotaPause(pause), /週枠が 100%/);
});

test("notebookGenerationPause: リセット時刻を過ぎていれば再開", () => {
  const now = Date.parse("2026-09-20T21:00:00+09:00");
  const pause = notebookGenerationPause(
    extractNotebookQuota(usageLatest, "board"),
    now,
  );
  assert.equal(pause, null);
});

test("loadNotebookQuota: URL が先、ファイルは後", async () => {
  const q = await loadNotebookQuota(cfg({ notebookQuotaUrls: ["http://taskdesk/usage"] }), {
    fetchJson: async (url) => (url.includes("taskdesk") ? usageLatest : null),
  });
  assert.ok(q);
  assert.equal(q.source, "http://taskdesk/usage");
  assert.equal(q.shortUsed, 90);
});

test("waitUntilNotebookQuotaAllows: 短期が下がるまで待つ", async () => {
  let n = 0;
  const sleeps: number[] = [];
  await waitUntilNotebookQuotaAllows(cfg({ notebookQuotaUrls: ["http://u"] }), {
    now: () => Date.parse("2026-09-20T18:50:00+09:00"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchJson: async () => {
      n += 1;
      if (n === 1) return usageLatest;
      return {
        providers: [
          {
            metrics: [
              {
                label: "Gemini Notebook (短期枠)",
                used_percent: 80,
                remaining_percent: 20,
                reset_at: "2026-09-20 20:53",
              },
              {
                label: "Gemini Notebook (週枠)",
                used_percent: 35.2,
                remaining_percent: 64.8,
                reset_at: "2026-09-24 12:53",
              },
            ],
          },
        ],
      };
    },
  });
  assert.equal(n, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0]! >= 5_000);
});

test("waitUntilNotebookQuotaAllows: ignore なら待たない", async () => {
  let fetched = false;
  await waitUntilNotebookQuotaAllows(cfg({ ignoreNotebookQuota: true, notebookQuotaUrls: ["http://u"] }), {
    fetchJson: async () => {
      fetched = true;
      return usageLatest;
    },
  });
  assert.equal(fetched, false);
});
