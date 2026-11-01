import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import {
  EXIT_QUOTA,
  EXIT_QUOTA_UNAVAILABLE,
  type NotebookQuotaConfig,
} from "./notebook-quota.ts";
import {
  checkNotebookQuotaStatus,
  type QuotaCheckDeps,
} from "./quota-check.ts";

export const DEFAULT_MIN_INBOX = 5;

export const EXIT_ALREADY_RUNNING = 10;
export const EXIT_INBOX_ERROR = 13;

export type RunningCheckResult = {
  running: boolean;
  reason?: "pipeline" | "chrome";
  matched?: string;
};

export function isPipelineOrChromeRunning(
  processes: readonly string[],
  options?: { chromeUserDataDir?: string },
): RunningCheckResult {
  const customProfile = options?.chromeUserDataDir?.trim();
  const pipelinePattern = /(?:dist|src)\/(?:orchestrate|cli|fill-inbox-cli)\.(?:js|ts)/;

  for (const raw of processes) {
    const cmd = raw.trim();
    if (!cmd) continue;
    if (/^(?:grep|pgrep)\b/.test(cmd)) continue;

    if (pipelinePattern.test(cmd)) {
      return {
        running: true,
        reason: "pipeline",
        matched: cmd,
      };
    }

    if (cmd.includes(".chrome-profile") || (customProfile && cmd.includes(customProfile))) {
      return {
        running: true,
        reason: "chrome",
        matched: cmd,
      };
    }
  }

  return { running: false };
}

export type InboxCountResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

export function countInboxPdfs(
  inboxDir: string,
  readDir: (path: string) => string[] = (p) => readdirSync(p),
): InboxCountResult {
  const dir = inboxDir.trim();
  if (!dir) {
    return {
      ok: false,
      error: "inbox ディレクトリが設定されていません（PAPER_INBOX_DIR）",
    };
  }
  try {
    const files = readDir(dir);
    const count = files.filter(
      (n) => n.toLowerCase().endsWith(".pdf") && !n.startsWith("."),
    ).length;
    return { ok: true, count };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `inbox ディレクトリを読み込めません（${dir}）: ${msg}`,
    };
  }
}

export function shouldFillInbox(inboxCount: number, minThreshold = DEFAULT_MIN_INBOX): boolean {
  return inboxCount < minThreshold;
}

export type ScheduledRunDecision =
  | {
      action: "skip";
      reason: "already_running";
      detail: string;
      exitCode: typeof EXIT_ALREADY_RUNNING;
    }
  | {
      action: "skip";
      reason: "quota_paused";
      detail: string;
      exitCode: typeof EXIT_QUOTA;
    }
  | {
      action: "skip";
      reason: "quota_unavailable";
      detail: string;
      exitCode: typeof EXIT_QUOTA_UNAVAILABLE;
    }
  | {
      action: "skip";
      reason: "inbox_error";
      detail: string;
      exitCode: typeof EXIT_INBOX_ERROR;
    }
  | {
      action: "run";
      fillInbox: boolean;
      inboxCount: number;
      minInbox: number;
      quotaMessage: string;
      exitCode: 0;
    };

export function getRunningProcesses(): string[] {
  try {
    const out = execSync("ps -axo command", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n");
  } catch {
    return [];
  }
}

export async function decideScheduledRun(
  processes: readonly string[],
  cfg: NotebookQuotaConfig,
  inboxDir: string,
  options: {
    minInbox?: number;
    chromeUserDataDir?: string;
    readDir?: (path: string) => string[];
  } = {},
  deps: QuotaCheckDeps = {},
): Promise<ScheduledRunDecision> {
  const minInbox = options.minInbox ?? DEFAULT_MIN_INBOX;

  // 1. すでに動いているか確認
  const running = isPipelineOrChromeRunning(processes, {
    chromeUserDataDir: options.chromeUserDataDir,
  });
  if (running.running) {
    const target = running.reason === "chrome" ? "専用プロファイルの Chrome" : "paper-pipeline";
    return {
      action: "skip",
      reason: "already_running",
      detail: `すでに ${target} が実行中のため終了します（${running.matched ?? ""}）`,
      exitCode: EXIT_ALREADY_RUNNING,
    };
  }

  // 2. Notebook 利用枠の確認
  const quota = await checkNotebookQuotaStatus(cfg, deps);
  if (quota.kind === "paused") {
    return {
      action: "skip",
      reason: "quota_paused",
      detail: quota.message,
      exitCode: EXIT_QUOTA,
    };
  }
  if (quota.kind === "unavailable") {
    return {
      action: "skip",
      reason: "quota_unavailable",
      detail: quota.message,
      exitCode: EXIT_QUOTA_UNAVAILABLE,
    };
  }

  // 3. inbox 論文数の確認と補充判定
  const inboxResult = countInboxPdfs(inboxDir, options.readDir);
  if (!inboxResult.ok) {
    return {
      action: "skip",
      reason: "inbox_error",
      detail: `${inboxResult.error}。安全のため実行を見送ります`,
      exitCode: EXIT_INBOX_ERROR,
    };
  }

  const needsFill = shouldFillInbox(inboxResult.count, minInbox);

  return {
    action: "run",
    fillInbox: needsFill,
    inboxCount: inboxResult.count,
    minInbox,
    quotaMessage: quota.message,
    exitCode: 0,
  };
}
