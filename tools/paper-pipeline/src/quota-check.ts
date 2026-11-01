import {
  DEFAULT_SHORT_STOP_PERCENT,
  DEFAULT_WEEKLY_STOP_PERCENT,
  EXIT_QUOTA,
  EXIT_QUOTA_UNAVAILABLE,
  fmtPct,
  formatQuotaPause,
  loadNotebookQuota,
  notebookGenerationPause,
  type NotebookQuota,
  type NotebookQuotaConfig,
  type NotebookQuotaPause,
} from "./notebook-quota.ts";

export { EXIT_QUOTA, EXIT_QUOTA_UNAVAILABLE };

export type QuotaCheckDecision =
  | {
      kind: "available";
      quota: NotebookQuota | null;
      exitCode: 0;
      message: string;
    }
  | {
      kind: "paused";
      pause: NotebookQuotaPause;
      quota: NotebookQuota;
      exitCode: typeof EXIT_QUOTA;
      message: string;
    }
  | {
      kind: "unavailable";
      reason: string;
      exitCode: typeof EXIT_QUOTA_UNAVAILABLE;
      message: string;
    };

export type QuotaCheckDeps = {
  fetchJson?: (url: string) => Promise<unknown | null>;
  readFile?: (path: string) => string | null;
  now?: () => number;
};

export async function checkNotebookQuotaStatus(
  cfg: NotebookQuotaConfig,
  deps: QuotaCheckDeps = {},
): Promise<QuotaCheckDecision> {
  if (cfg.ignoreNotebookQuota) {
    return {
      kind: "available",
      quota: null,
      exitCode: 0,
      message: "Notebook 利用枠の確認は無視する設定（ignoreNotebookQuota）のため利用可能とみなします",
    };
  }

  const quota = await loadNotebookQuota(cfg, deps);
  if (!quota) {
    return {
      kind: "unavailable",
      reason: "quota_fetch_failed",
      exitCode: EXIT_QUOTA_UNAVAILABLE,
      message: "Notebook の利用量が taskdesk / 利用量ボードから読めません。安全のため動かしません",
    };
  }

  const pause = notebookGenerationPause(
    quota,
    (deps.now ?? Date.now)(),
    cfg.notebookShortStopPercent ?? DEFAULT_SHORT_STOP_PERCENT,
    cfg.notebookWeeklyStopPercent ?? DEFAULT_WEEKLY_STOP_PERCENT,
  );

  if (pause) {
    return {
      kind: "paused",
      pause,
      quota,
      exitCode: EXIT_QUOTA,
      message: formatQuotaPause(pause, quota),
    };
  }

  const shortStr = quota.shortUsed != null ? `短期: ${fmtPct(quota.shortUsed)}%` : "短期: 不明";
  const weeklyStr = quota.weeklyUsed != null ? `週: ${fmtPct(quota.weeklyUsed)}%` : "週: 不明";
  const sourceStr = quota.source ? `（${quota.source}）` : "";
  return {
    kind: "available",
    quota,
    exitCode: 0,
    message: `Notebook 利用枠は空いています（${shortStr}, ${weeklyStr}）${sourceStr}`,
  };
}
