import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countInboxPdfs,
  decideScheduledRun,
  EXIT_ALREADY_RUNNING,
  EXIT_INBOX_ERROR,
  EXIT_LOGIN_REQUIRED,
  EXIT_PROCESS_CHECK_ERROR,
  getRunningProcesses,
  isPipelineOrChromeRunning,
  parseMinInbox,
  shouldFillInbox,
} from "./scheduled-run.ts";
import { EXIT_QUOTA, EXIT_QUOTA_UNAVAILABLE, type NotebookQuotaConfig } from "./notebook-quota.ts";
import { humanPauseMode, NeedVisibleChromeError } from "./human.ts";

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

test("getRunningProcesses: 正常時は ok: true と配列を返し、失敗時は ok: false とエラーを返す", () => {
  const success = getRunningProcesses(() => "node dist/orchestrate.js\nbash\n");
  assert.equal(success.ok, true);
  if (success.ok) {
    assert.equal(success.processes.length, 3);
  }

  const failure = getRunningProcesses(() => {
    throw new Error("ps command failed");
  });
  assert.equal(failure.ok, false);
  if (!failure.ok) {
    assert.match(failure.error, /ps command failed/);
  }
});

test("parseMinInbox: 0 以上の整数のみ許可し、小数はエラー、空はフォールバック", () => {
  assert.equal(parseMinInbox("5"), 5);
  assert.equal(parseMinInbox("0"), 0);
  assert.equal(parseMinInbox(""), 5);
  assert.equal(parseMinInbox(undefined), 5);

  assert.throws(() => parseMinInbox("-1"), /0 以上の整数/);
  assert.throws(() => parseMinInbox("3.5"), /0 以上の整数/);
  assert.throws(() => parseMinInbox("abc"), /0 以上の整数/);
});

test("countInboxPdfs: 隠しファイルを除外して PDF だけ数える (ok: true)", () => {
  const files = [".DS_Store", ".gitkeep", "paper1.pdf", "paper2.PDF", "notes.txt", "doc.docx"];
  const res = countInboxPdfs("/mock/inbox", () => files);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.count, 2);
  }
});

test("countInboxPdfs: 未指定のときは ok: false でエラーを返す（読めないときは動かさない側に倒す）", () => {
  const res = countInboxPdfs("");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /設定されていません/);
  }
});

test("countInboxPdfs: フォルダが存在しない・読めない場合は ok: false でエラーを返す", () => {
  const res = countInboxPdfs("/non/existent/path", () => {
    throw new Error("ENOENT");
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /読み込めません/);
  }
});

test("shouldFillInbox: しきい値未満なら true、以上なら false", () => {
  assert.equal(shouldFillInbox(0, 5), true);
  assert.equal(shouldFillInbox(4, 5), true);
  assert.equal(shouldFillInbox(5, 5), false);
  assert.equal(shouldFillInbox(6, 5), false);
  assert.equal(shouldFillInbox(2, 3), true);
  assert.equal(shouldFillInbox(3, 3), false);
});

test("decideScheduledRun: プロセス一覧取得失敗時は skip (process_check_error, exit 14)", async () => {
  const cfg = mockQuotaConfig();
  const res = await decideScheduledRun(
    { ok: false, error: "ps failure" },
    cfg,
    "/mock/inbox",
  );
  assert.equal(res.action, "skip");
  assert.equal(res.reason, "process_check_error");
  assert.equal(res.exitCode, EXIT_PROCESS_CHECK_ERROR);
  assert.match(res.detail, /プロセス一覧の取得に失敗しました/);
});

test("decideScheduledRun: パイプライン実行中は skip (already_running, exit 10)", async () => {
  const cfg = mockQuotaConfig();
  const res = await decideScheduledRun(
    ["node dist/orchestrate.js"],
    cfg,
    "/mock/inbox",
  );
  assert.equal(res.action, "skip");
  assert.equal(res.reason, "already_running");
  assert.equal(res.exitCode, EXIT_ALREADY_RUNNING);
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
  const res = await decideScheduledRun([], cfg, "/mock/inbox", {}, {
    fetchJson: async () => highShortUsage,
    now: () => Date.parse("2026-11-01T10:00:00+09:00"),
  });
  assert.equal(res.action, "skip");
  assert.equal(res.reason, "quota_paused");
  assert.equal(res.exitCode, EXIT_QUOTA);
});

test("decideScheduledRun: 利用量が読めないなら skip (quota_unavailable, exit 12)", async () => {
  const cfg = mockQuotaConfig();
  const res = await decideScheduledRun([], cfg, "/mock/inbox", {}, {
    fetchJson: async () => null,
    readFile: () => null,
  });
  assert.equal(res.action, "skip");
  assert.equal(res.reason, "quota_unavailable");
  assert.equal(res.exitCode, EXIT_QUOTA_UNAVAILABLE);
});

test("decideScheduledRun: inbox が未設定または読めないなら skip (inbox_error, exit 13)", async () => {
  const okUsage = {
    providers: [
      {
        metrics: [
          {
            label: "Gemini Notebook (短期枠)",
            used_percent: 30,
            reset_at: "2026-11-01 20:00",
          },
        ],
      },
    ],
  };
  const cfg = mockQuotaConfig();
  // inboxDir が未設定
  const resEmpty = await decideScheduledRun([], cfg, "", {}, {
    fetchJson: async () => okUsage,
  });
  assert.equal(resEmpty.action, "skip");
  assert.equal(resEmpty.reason, "inbox_error");
  assert.equal(resEmpty.exitCode, EXIT_INBOX_ERROR);

  // inboxDir の読み込み失敗
  const resError = await decideScheduledRun(
    [],
    cfg,
    "/invalid/path",
    {
      readDir: () => {
        throw new Error("EACCES");
      },
    },
    {
      fetchJson: async () => okUsage,
    },
  );
  assert.equal(resError.action, "skip");
  assert.equal(resError.reason, "inbox_error");
  assert.equal(resError.exitCode, EXIT_INBOX_ERROR);
});

test("decideScheduledRun: 枠が空いていて論文数が足りなければ fillInbox=true で run (exit 0)", async () => {
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
  const res = await decideScheduledRun(
    [],
    cfg,
    "/mock/inbox",
    {
      minInbox: 5,
      readDir: () => ["a.pdf", "b.pdf"],
    },
    {
      fetchJson: async () => okUsage,
      now: () => Date.parse("2026-11-01T10:00:00+09:00"),
    },
  );
  assert.equal(res.action, "run");
  assert.equal(res.exitCode, 0);
  if (res.action === "run") {
    assert.equal(res.fillInbox, true);
    assert.equal(res.inboxCount, 2);
    assert.equal(res.minInbox, 5);
  }
});

test("decideScheduledRun: 枠が空いていて論文数が足りていれば fillInbox=false で run (exit 0)", async () => {
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
  const res = await decideScheduledRun(
    [],
    cfg,
    "/mock/inbox",
    {
      minInbox: 5,
      readDir: () => ["1.pdf", "2.pdf", "3.pdf", "4.pdf", "5.pdf", "6.pdf"],
    },
    {
      fetchJson: async () => okUsage,
      now: () => Date.parse("2026-11-01T10:00:00+09:00"),
    },
  );
  assert.equal(res.action, "run");
  assert.equal(res.exitCode, 0);
  if (res.action === "run") {
    assert.equal(res.fillInbox, false);
    assert.equal(res.inboxCount, 6);
  }
});

test("humanPauseMode & NeedVisibleChromeError: ヘッドレス中のログイン壁と EXIT_LOGIN_REQUIRED 定数", () => {
  const mode = humanPauseMode({ headed: false });
  assert.equal(mode, "promote");

  const err = new NeedVisibleChromeError(
    "NotebookLM",
    "https://accounts.google.com/signin",
    "ログイン待ち",
  );
  assert.equal(err.name, "NeedVisibleChromeError");
  assert.match(err.message, /NotebookLM: ログインまたは追加確認が必要です/);
  assert.equal(EXIT_LOGIN_REQUIRED, 15);
});
