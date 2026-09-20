import { mkdirSync } from "node:fs";
import {
  closeBrowser,
  launchBrowser,
  pageAlive,
  recoverStuckPage,
  type BrowserSession,
} from "./browser.ts";
import { assertConfigPaths, helpText, loadConfig, parseArgv, type AppConfig } from "./config.ts";
import { listInboxPdfs, listStudioFollowupPdfs, listVideoRepairPdfs, listWorkPdfs, mergeInboxAndVideoRepair } from "./inbox.ts";
import { error as logError, firstLine, log, warn } from "./log.ts";
import { loadExistingFromEduShare, processOnePaper, repairSciSpaceCardMeta, repairSciSpaceRecordLinks } from "./pipeline.ts";
import { formatStudioGenerateJa } from "./studio-select.ts";
import { EXIT_WAITING } from "./waiting.ts";

const MAX_RELAUNCH = 2;
let activeSession: BrowserSession | null = null;

async function relaunch(session: BrowserSession, cfg: AppConfig): Promise<BrowserSession> {
  await closeBrowser(session);
  log("ブラウザを再起動します");
  const next = await launchBrowser(cfg);
  activeSession = next;
  return next;
}

function installInterruptLogs(): void {
  const stop = (sig: string) => {
    logError(`プロセスが ${sig} で中断されました`);
    const session = activeSession;
    activeSession = null;
    if (session) {
      void closeBrowser(session).finally(() => process.exit(1));
      return;
    }
    process.exit(1);
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => stop(sig));
  }
  process.on("uncaughtException", (e) => {
    logError(`未捕捉例外: ${firstLine(e)}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    logError(`未処理の rejection: ${firstLine(e)}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  installInterruptLogs();
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText());
    return;
  }
  const overrides = parseArgv(argv);
  const cfg = loadConfig(overrides);
  assertConfigPaths(cfg);
  mkdirSync(cfg.workDir, { recursive: true });
  const items = mergeInboxAndVideoRepair(
    listInboxPdfs(cfg.inboxDir, cfg.workDir, cfg.onlyFilename),
    [
      ...listVideoRepairPdfs(cfg.workDir, cfg.onlyFilename),
      ...listWorkPdfs(cfg.workDir, cfg.onlyFilename),
      ...(cfg.studioGenerateExplicit
        ? listStudioFollowupPdfs(cfg.workDir, cfg.studioGenerate, cfg.onlyFilename)
        : []),
    ],
  );
  if (cfg.onlyFilename && items.length === 0) {
    log(`入力ディレクトリに ${cfg.onlyFilename} はありません（SciSpace リンク補修は作業フォルダを見ます）`);
  }
  log(`入力 ${cfg.inboxDir} の PDF ${items.length} 件`);
  log(`作業 ${cfg.workDir}`);
  log(`Studio 生成: ${formatStudioGenerateJa(cfg.studioGenerate)}`);

  let session = await launchBrowser(cfg);
  activeSession = session;
  const processed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  try {
    if (!(await pageAlive(session.page))) {
      session = await relaunch(session, cfg);
    }
    let existing = await loadExistingFromEduShare(session.page, cfg);
    if (!(await recoverStuckPage(session.page))) {
      warn("論文一覧のあとブラウザが応答しないため再起動します");
      session = await relaunch(session, cfg);
    }
    const repaired = await repairSciSpaceRecordLinks(session.page, cfg);
    processed.push(...repaired.updated);
    failed.push(...repaired.failed);
    if (repaired.updated.length || repaired.failed.length) {
      log(
        `SciSpace リンク補修: 更新 ${repaired.updated.length} / 失敗 ${repaired.failed.length}`,
      );
    }
    const metaRepaired = await repairSciSpaceCardMeta(session.page, cfg, existing);
    processed.push(...metaRepaired.updated);
    failed.push(...metaRepaired.failed);
    if (metaRepaired.updated.length || metaRepaired.failed.length) {
      log(
        `SciSpace メタ補修: 更新 ${metaRepaired.updated.length} / 失敗 ${metaRepaired.failed.length}`,
      );
      if (items.length > 0) {
        existing = await loadExistingFromEduShare(session.page, cfg);
      }
    }
    for (const item of items) {
      log(`--- ${item.filename} ---`);
      let r: "done" | "skipped" | "failed" | "waiting" = "failed";
      for (let attempt = 0; attempt <= MAX_RELAUNCH; attempt++) {
        if (!(await pageAlive(session.page))) {
          warn(`${item.filename}: ブラウザ切断を検出したため再起動します`);
          session = await relaunch(session, cfg);
        }
        r = await processOnePaper(session.page, cfg, item, existing);
        if (r === "waiting") break;
        if (r !== "failed" || (await pageAlive(session.page)) || attempt >= MAX_RELAUNCH) {
          break;
        }
        warn(
          `${item.filename}: ブラウザ切断のため再起動して同じ論文を再試行します (${attempt + 1}/${MAX_RELAUNCH})`,
        );
        session = await relaunch(session, cfg);
      }
      if (r === "done") processed.push(item.filename);
      else if (r === "skipped") skipped.push(item.filename);
      else if (r === "waiting") {
        log(`${item.filename}: 生成待ちのため Chrome を明け渡します`);
        process.exitCode = EXIT_WAITING;
        break;
      } else {
        failed.push(item.filename);
        if (cfg.stopOnError) break;
        if (!(await pageAlive(session.page))) {
          warn("失敗後もブラウザが閉じているため再起動して次の論文へ進みます");
          session = await relaunch(session, cfg);
        }
      }
    }
  } finally {
    if (failed.length > 0 && cfg.headed && (await pageAlive(session.page))) {
      log("失敗があるためブラウザは開いたまま 3 秒待ちます（確認用）");
      await session.page.waitForTimeout(3000).catch(() => undefined);
    }
    await closeBrowser(session);
    activeSession = null;
  }

  log(
    `結果: 完了 ${processed.length} / スキップ ${skipped.length} / 失敗 ${failed.length}${
      process.exitCode === EXIT_WAITING ? " / 生成待ち" : ""
    }`,
  );
  if (failed.length) {
    logError(`失敗: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  logError(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
