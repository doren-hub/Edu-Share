import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countInboxPdfs,
  decideScheduledRun,
  isPipelineOrChromeRunning,
  shouldFillInbox,
} from "./scheduled-run.ts";
import type { NotebookQuotaConfig } from "./notebook-quota.ts";

const mockQuotaConfig = (over: Partial<NotebookQuotaConfig> = {}): NotebookQuotaConfig => ({
  ignoreNotebookQuota: false,
  notebookQuotaUrls: ["http://mock/usage"],
  notebookQuotaFiles: [],
  notebookShortStopPercent: 85,
  notebookWeeklyStopPercent: 100,
  ...over,
});

test("isPipelineOrChromeRunning: 関係ないプロセスのみのときは false", () => {
  const procs = [
    "/bin/bash ./scripts/some-script.sh",
    "node /app/node_modules/next/dist/bin/next dev",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default",
  ];
  const res = isPipelineOrChromeRunning(procs);
  assert.equal(res.running, false);
});

test("isPipelineOrChromeRunning: grep / pgrep 自身のコマンド行は無視する", () => {
  const procs = [
    "pgrep -f (dist|src)/(orchestrate|cli|fill-inbox-cli)\\.(js|ts)",
    "grep --color=auto .chrome-profile",
  ];
  const res = isPipelineOrChromeRunning(procs);
  assert.equal(res.running, false);
});

test("isPipelineOrChromeRunning: orchestrator / worker / fill-inbox の実行を検出する", () => {
  assert.equal(
    isPipelineOrChromeRunning(["node dist/orchestrate.js --headless"]).running,
    true,
  );
  assert.equal(
    isPipelineOrChromeRunning(["node /path/dist/cli.js --only test.pdf"]).running,
    true,
  );
  assert.equal(
    isPipelineOrChromeRunning(["node dist/fill-inbox-cli.js"]).running,
    true,
  );
  assert.equal(
    isPipelineOrChromeRunning(["node --import tsx src/orchestrate.ts"]).running,
    true,
  );
});

test("isPipelineOrChromeRunning: 専用プロファイルの Chrome を検出する", () => {
  const chromeCmd =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/test/Developer/edu-share-app/tools/paper-pipeline/.chrome-profile --headless";
  const res = isPipelineOrChromeRunning([chromeCmd]);
  assert.equal(res.running, true);
  assert.equal(res.reason, "chrome");
});

test("isPipelineOrChromeRunning: カスタム chromeUserDataDir を検出する", () => {
  const custom = "/custom/chrome/dir";
  const chromeCmd = `/Applications/Google Chrome.app/... --user-data-dir=${custom}`;
  const res = isPipelineOrChromeRunning([chromeCmd], { chromeUserDataDir: custom });
  assert.equal(res.running, true);
  assert.equal(res.reason, "chrome");
});

test("countInboxPdfs: 隠しファイルを除外して PDF だけ数える", () => {
  const files = [".DS_Store", ".gitkeep", "paper1.pdf", "paper2.PDF", "notes.txt", "doc.docx"];
  const count = countInboxPdfs("/mock/inbox", () => files);
  assert.equal(count, 2);
});

test("countInboxPdfs: フォルダが存在しない場合は 0 を返す", () => {
  const count = countInboxPdfs("/non/existent/path", () => {
    throw new Error("ENOENT");
  });
  assert.equal(count, 0);
});

test("shouldFillInbox: しきい値未満なら true、以上なら false", () => {
  assert.equal(shouldFillInbox(0, 5), true);
  assert.equal(shouldFillInbox(4, 5), true);
  assert.equal(shouldFillInbox(5, 5), false);
  assert.equal(shouldFillInbox(6, 5), false);
  assert.equal(shouldFillInbox(2, 3), true);
  assert.equal(shouldFillInbox(3, 3), false);
});

test("decideScheduledRun: パイプライン実行中は skip (already_running)", async () => {
  const cfg = mockQuotaConfig();
  const res = await decideScheduledRun(
    ["node dist/orchestrate.js"],
    cfg,
    3,
  );
  assert.equal(res.action, "skip");
  assert.equal(res.reason, "already_running");
});

test("decideScheduledRun: 利用枠が一時停止なら skip (quota_paused, exit 11)", async () => {
  const highShortUsage = {
    providers: [
      {
        metrics: [
          {
            label: "Gemini Notebook (短期枠)",
            used_percent: 92,
            reset_at: "2026-11-01 20:00",
          },
        ],
      },
    ],
  };
  const cfg = mockQuotaConfig();
  const res = await decideScheduledRun([], cfg, 3, {}, {
    fetchJson: async () => highShortUsage,
    now: () => Date.parse("2026-11-01T10:00:00+09:00"),
  });
  assert.equal(res.action, "skip");
  assert.equal(res.reason, "quota_paused");
  assert.equal(res.exitCode, 11);
});

test("decideScheduledRun: 利用量が読めないなら skip (quota_unavailable, exit 12)", async () => {
  const cfg = mockQuotaConfig();
  const res = await decideScheduledRun([], cfg, 3, {}, {
    fetchJson: async () => null,
    readFile: () => null,
  });
  assert.equal(res.action, "skip");
  assert.equal(res.reason, "quota_unavailable");
  assert.equal(res.exitCode, 12);
});

test("decideScheduledRun: 枠が空いていて論文数が足りなければ fillInbox=true で run", async () => {
  const okUsage = {
    providers: [
      {
        metrics: [
          {
            label: "Gemini Notebook (短期枠)",
            used_percent: 40,
            reset_at: "2026-11-01 20:00",
          },
          {
            label: "Gemini Notebook (週枠)",
            used_percent: 50,
            reset_at: "2026-11-05 12:00",
          },
        ],
      },
    ],
  };
  const cfg = mockQuotaConfig();
  const res = await decideScheduledRun([], cfg, 2, { minInbox: 5 }, {
    fetchJson: async () => okUsage,
    now: () => Date.parse("2026-11-01T10:00:00+09:00"),
  });
  assert.equal(res.action, "run");
  if (res.action === "run") {
    assert.equal(res.fillInbox, true);
    assert.equal(res.inboxCount, 2);
    assert.equal(res.minInbox, 5);
  }
});

test("decideScheduledRun: 枠が空いていて論文数が足りていれば fillInbox=false で run", async () => {
  const okUsage = {
    providers: [
      {
        metrics: [
          {
            label: "Gemini Notebook (短期枠)",
            used_percent: 40,
            reset_at: "2026-11-01 20:00",
          },
          {
            label: "Gemini Notebook (週枠)",
            used_percent: 50,
            reset_at: "2026-11-05 12:00",
          },
        ],
      },
    ],
  };
  const cfg = mockQuotaConfig();
  const res = await decideScheduledRun([], cfg, 6, { minInbox: 5 }, {
    fetchJson: async () => okUsage,
    now: () => Date.parse("2026-11-01T10:00:00+09:00"),
  });
  assert.equal(res.action, "run");
  if (res.action === "run") {
    assert.equal(res.fillInbox, false);
    assert.equal(res.inboxCount, 6);
  }
});
