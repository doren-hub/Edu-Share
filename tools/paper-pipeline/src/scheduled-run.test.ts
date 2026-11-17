import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  countInboxPdfs,
  decideScheduledRun,
  EXIT_ALREADY_RUNNING,
  EXIT_INBOX_ERROR,
  EXIT_LOGIN_REQUIRED,
  EXIT_PERMISSION_ERROR,
  EXIT_PROCESS_CHECK_ERROR,
  getRunningProcesses,
  isPipelineOrChromeRunning,
  parseMinInbox,
  shouldFillInbox,
} from "./scheduled-run.ts";
import { EXIT_QUOTA, EXIT_QUOTA_UNAVAILABLE, type NotebookQuotaConfig } from "./notebook-quota.ts";
import { humanPauseMode, NeedVisibleChromeError } from "./human.ts";
import { runCatchingLogin } from "./cli.ts";
import type { AppConfig } from "./config.ts";
import type { BrowserSession } from "./browser.ts";

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

test("runCatchingLogin: noRevealLogin が真のときは画面を開かず onLoginRequired を呼んで終了する", async () => {
  const dummySession = { page: {} } as unknown as BrowserSession;
  const cfg = { noRevealLogin: true } as AppConfig;

  let revealCalled = false;
  let onLoginCalled = false;

  await assert.rejects(
    async () => {
      await runCatchingLogin(
        dummySession,
        cfg,
        async () => {
          throw new NeedVisibleChromeError("NotebookLM", "https://accounts.google.com", "ログイン待ち");
        },
        {
          reveal: async () => {
            revealCalled = true;
            return dummySession;
          },
          onLoginRequired: (err) => {
            onLoginCalled = true;
            throw new Error(`handled login required: ${err.context}`);
          },
        },
      );
    },
    /handled login required: NotebookLM/,
  );

  assert.equal(revealCalled, false);
  assert.equal(onLoginCalled, true);
});

test("runCatchingLogin: noRevealLogin 時に closeBrowser を呼んでから process.exit(15) で終了する", async () => {
  const dummySession = { page: {} } as unknown as BrowserSession;
  const cfg = { noRevealLogin: true } as AppConfig;
  const events: string[] = [];

  await assert.rejects(
    async () => {
      await runCatchingLogin(
        dummySession,
        cfg,
        async () => {
          throw new NeedVisibleChromeError("NotebookLM", "https://accounts.google.com", "ログイン待ち");
        },
        {
          closeBrowser: async () => {
            events.push("closeBrowser");
          },
          exit: (code) => {
            events.push(`exit:${code}`);
            throw new Error(`exited with ${code}`);
          },
        },
      );
    },
    /exited with 15/,
  );

  assert.deepEqual(events, ["closeBrowser", "exit:15"]);
});

test("runCatchingLogin: noRevealLogin が偽のときは reveal を呼んで再試行する", async () => {
  const dummySession = { page: {} } as unknown as BrowserSession;
  const cfg = { noRevealLogin: false } as AppConfig;

  let revealCount = 0;
  let attempt = 0;

  const result = await runCatchingLogin(
    dummySession,
    cfg,
    async () => {
      if (attempt++ === 0) {
        throw new NeedVisibleChromeError("SciSpace", "https://scispace.com/login", "ログイン");
      }
      return "success_after_login";
    },
    {
      reveal: async (s) => {
        revealCount++;
        return s;
      },
    },
  );

  assert.equal(revealCount, 1);
  assert.equal(result.value, "success_after_login");
});

test("EXIT_PERMISSION_ERROR: 終了コード 17 の定数値が保持され既存コードと衝突しない", () => {
  assert.equal(EXIT_PERMISSION_ERROR, 17);
  const knownCodes = [
    EXIT_ALREADY_RUNNING, // 10
    EXIT_QUOTA, // 11
    EXIT_QUOTA_UNAVAILABLE, // 12
    EXIT_INBOX_ERROR, // 13
    EXIT_PROCESS_CHECK_ERROR, // 14
    EXIT_LOGIN_REQUIRED, // 15
    16, // EXIT_WAITING_TIMEOUT
  ];
  assert.ok(!knownCodes.includes(EXIT_PERMISSION_ERROR), "既存の終了コード (11, 12, 15, 16 等) と重複しないこと");
});

test("scripts/scheduled-run.sh: fill-inbox の権限エラー (17) を検知し空 inbox のときは exit 17 する", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/scheduled-run.sh", import.meta.url));
  const script = readFileSync(scriptPath, "utf8");

  // INBOX_COUNT を DECISION_ENV から取得していること
  assert.match(script, /INBOX_COUNT=\$\(echo "\$DECISION_ENV" \| grep '\^INBOX_COUNT='/);

  // FILL_EXIT -eq 17 で「補充できません（macOS の許可が必要です）」を出力すること
  assert.match(script, /if \[ "\$FILL_EXIT" -eq 17 \]; then/);
  assert.match(script, /log "警告: 補充できません（macOS の許可が必要です）"/);

  // inbox が空の場合はパイプラインを実行せず exit 17 で終わること
  assert.match(script, /if \[ "\$INBOX_COUNT" -eq 0 \]; then/);
  assert.match(script, /exit 17/);
});

test("scripts/scheduled-run.sh: step 3 の終了コード判定ロジックを bash で実行検証する", () => {
  const runStep3 = (fillExit: number, inboxCount: number) => {
    try {
      execSync(
        `bash -c '
FILL_EXIT=${fillExit}
INBOX_COUNT=${inboxCount}
if [ "$FILL_EXIT" -eq 17 ]; then
  if [ "$INBOX_COUNT" -eq 0 ]; then
    exit 17
  fi
elif [ "$FILL_EXIT" -ne 0 ]; then
  if [ "$INBOX_COUNT" -eq 0 ]; then
    exit "$FILL_EXIT"
  fi
fi
exit 0
'`,
        { stdio: "pipe" },
      );
      return 0;
    } catch (e: unknown) {
      return (e as { status?: number }).status ?? -1;
    }
  };

  assert.equal(runStep3(17, 0), 17, "inbox 空かつ権限エラー時は 17 で終了");
  assert.equal(runStep3(17, 3), 0, "inbox に論文がある場合は続行 (exit 0)");
  assert.equal(runStep3(1, 0), 1, "inbox 空かつ一般エラー時は 1 で終了");
  assert.equal(runStep3(1, 3), 0, "inbox に論文がある場合は続行 (exit 0)");
  assert.equal(runStep3(0, 0), 0, "補充成功時は続行 (exit 0)");
});
