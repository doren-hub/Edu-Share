import { loadNotebookQuotaConfig, parseArgv } from "./config.ts";
import { PACKAGE_ROOT, resolvePathMaybe } from "./env.ts";
import { error as logError, log, warn } from "./log.ts";
import {
  decideScheduledRun,
  DEFAULT_MIN_INBOX,
  getRunningProcesses,
} from "./scheduled-run.ts";

function help(): string {
  return `定期実行の判断を行う (プロセス確認、枠確認、inbox 補充要否)

使い方:
  npm run scheduled-decide
  npm run scheduled-decide -- --json

終了コード:
  0: パイプライン実行可 (run)
  10: すでに実行中 (skip: already_running)
  11: 利用枠上限 (skip: quota_paused)
  12: 利用量データ取得不可 (skip: quota_unavailable)
  13: inbox ディレクトリ確認不可 (skip: inbox_error)
  1: 引数エラーまたは予期せぬ失敗
`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(help());
    return;
  }
  const isJson = argv.includes("--json");
  const filtered = argv.filter((a) => a !== "--json");
  const parsed = parseArgv(filtered);
  const cfg = loadNotebookQuotaConfig(parsed);

  const inboxDir = resolvePathMaybe(
    (parsed.inbox || process.env.PAPER_INBOX_DIR || "").trim(),
    PACKAGE_ROOT,
  );
  const chromeUserDataDir = resolvePathMaybe(
    (process.env.CHROME_USER_DATA_DIR ?? ".chrome-profile").trim(),
    PACKAGE_ROOT,
  );
  const rawMin = (process.env.INBOX_MIN_PAPERS ?? "").trim();
  const minInbox = rawMin && Number.isFinite(Number(rawMin)) ? Number(rawMin) : DEFAULT_MIN_INBOX;

  const processes = getRunningProcesses();

  const decision = await decideScheduledRun(processes, cfg, inboxDir, {
    minInbox,
    chromeUserDataDir,
  });

  if (isJson) {
    console.log(JSON.stringify(decision, null, 2));
  } else {
    if (decision.action === "run") {
      log(`[実行判定] ${decision.quotaMessage}`);
      log(
        `[実行判定] inbox 未処理: ${decision.inboxCount} 件 (しきい値: ${decision.minInbox} 件) -> 補充: ${
          decision.fillInbox ? "必要" : "不要"
        }`,
      );
    } else {
      if (decision.exitCode === 10 || decision.exitCode === 11) {
        log(`[スキップ判定] ${decision.detail}`);
      } else {
        warn(`[スキップ判定] ${decision.detail}`);
      }
    }
  }

  process.exitCode = decision.exitCode;
}

main().catch((e) => {
  logError(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
