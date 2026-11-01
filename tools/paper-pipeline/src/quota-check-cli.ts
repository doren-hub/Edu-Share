import { loadNotebookQuotaConfig, parseArgv } from "./config.ts";
import { error as logError, log, warn } from "./log.ts";
import { checkNotebookQuotaStatus, EXIT_QUOTA, EXIT_QUOTA_UNAVAILABLE } from "./quota-check.ts";

function help(): string {
  return `NotebookLM の利用枠を確認する

使い方:
  npm run quota-check
  npm run quota-check -- --notebook-short-stop-percent 80
  npm run quota-check -- --json

終了コード:
  0: 利用枠は空いています
  11: 止める値に達しています（EXIT_QUOTA）
  12: 利用量を読めません（EXIT_QUOTA_UNAVAILABLE）
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
  const cfg = loadNotebookQuotaConfig(parseArgv(filtered));

  const result = await checkNotebookQuotaStatus(cfg);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.exitCode === 0 || result.exitCode === EXIT_QUOTA) {
      log(result.message);
    } else {
      warn(result.message);
    }
  }

  process.exitCode = result.exitCode;
}

main().catch((e) => {
  logError(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
