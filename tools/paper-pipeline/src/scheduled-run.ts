import { readdirSync } from "node:fs";
import { type NotebookQuotaConfig } from "./notebook-quota.ts";
import { checkNotebookQuotaStatus, type QuotaCheckDecision, type QuotaCheckDeps } from "./quota-check.ts";

export const DEFAULT_MIN_INBOX = 5;

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
    // grep や pgrep コマンド自身の引数は除外
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

export function countInboxPdfs(
  inboxDir: string,
  readDir: (path: string) => string[] = (p) => readdirSync(p),
): number {
  try {
    const files = readDir(inboxDir);
    return files.filter(
      (n) => n.toLowerCase().endsWith(".pdf") && !n.startsWith("."),
    ).length;
  } catch {
    return 0;
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
    }
  | {
      action: "skip";
      reason: "quota_paused";
      detail: string;
      exitCode: 11;
    }
  | {
      action: "skip";
      reason: "quota_unavailable";
      detail: string;
      exitCode: 12;
    }
  | {
      action: "run";
      fillInbox: boolean;
      inboxCount: number;
      minInbox: number;
      quotaMessage: string;
    };

export async function decideScheduledRun(
  processes: readonly string[],
  cfg: NotebookQuotaConfig,
  inboxCount: number,
  options: {
    minInbox?: number;
    chromeUserDataDir?: string;
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
    };
  }

  // 2. Notebook 利用枠の確認
  const quota = await checkNotebookQuotaStatus(cfg, deps);
  if (quota.kind === "paused") {
    return {
      action: "skip",
      reason: "quota_paused",
      detail: quota.message,
      exitCode: 11,
    };
  }
  if (quota.kind === "unavailable") {
    return {
      action: "skip",
      reason: "quota_unavailable",
      detail: quota.message,
      exitCode: 12,
    };
  }

  // 3. 補充の判定
  const needsFill = shouldFillInbox(inboxCount, minInbox);

  return {
    action: "run",
    fillInbox: needsFill,
    inboxCount,
    minInbox,
    quotaMessage: quota.message,
  };
}
