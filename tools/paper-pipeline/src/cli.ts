import { mkdirSync } from "node:fs";
import type { Page } from "playwright";
import {
  closeBrowser,
  isTargetClosedMessage,
  launchBrowser,
  pageAlive,
  relaunchBrowser,
  type BrowserSession,
} from "./browser.ts";
import { assertConfigPaths, helpText, loadConfig, parseArgv, type AppConfig } from "./config.ts";
import { NeedVisibleChromeError, waitUntilUnblocked } from "./human.ts";
import { maybeLoginEduShare } from "./steps/edushare.ts";
import { listEduMaterialRepairPdfs, listExistingWorkPapers, listInboxPdfs, listRawPasteRepairPdfs, listStudioFollowupPdfs, listVideoRepairPdfs, listWorkPdfs, mergeInboxAndVideoRepair } from "./inbox.ts";
import { error as logError, firstLine, log, warn } from "./log.ts";
import { processOnePaper, repairSciSpaceCardMeta, repairSciSpaceRecordLinks } from "./pipeline.ts";
import { formatStudioGenerateJa } from "./studio-select.ts";
import { EXIT_QUOTA } from "./notebook-quota.ts";
import { EXIT_WAITING, isRetryCooling } from "./waiting.ts";
import { emptyState, loadState, studioKickoffBegun } from "./state.ts";
import { videoFileReady } from "./video-file.ts";

const MAX_RELAUNCH = 2;
let activeSession: BrowserSession | null = null;
let shuttingDown = false;

function loadPaperState(item: { paperDir: string; filename: string; absPath: string }) {
  return loadState(
    item.paperDir,
    emptyState({
      filename: item.filename,
      inboxPdfPath: item.absPath,
      paperDir: item.paperDir,
    }),
  );
}

async function relaunch(session: BrowserSession, cfg: AppConfig): Promise<BrowserSession> {
  if (shuttingDown) return session;
  log("ブラウザを再起動します");
  const next = await relaunchBrowser(session, cfg);
  activeSession = next;
  return next;
}

function withHeaded(cfg: AppConfig, headed: boolean): AppConfig {
  return { ...cfg, headed };
}

function looksLikeLoginUrl(url: string): boolean {
  return /accounts\.google|signin\.google|\/auth\/login/i.test(url);
}

async function revealForLogin(
  session: BrowserSession,
  cfg: AppConfig,
  err: NeedVisibleChromeError,
): Promise<BrowserSession> {
  log(`${err.context}: ログイン確認のため Chrome を画面付きで開きます`);
  session = await relaunch(session, withHeaded(cfg, true));
  if (err.url) {
    await session.page.goto(err.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  }
  if (err.context === "Edu Share") {
    await maybeLoginEduShare(session.page, cfg.eduShareBaseUrl, cfg.eduShareEmail, cfg.eduSharePassword);
  }
  await waitUntilUnblocked(session.page, err.context);
  if (cfg.headed) return session;
  const resume = session.page.url();
  log("ログインが終わったので Chrome をヘッドレスに戻します");
  session = await relaunch(session, withHeaded(cfg, false));
  if (resume && !looksLikeLoginUrl(resume)) {
    await session.page.goto(resume, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  }
  return session;
}

async function runCatchingLogin<T>(
  session: BrowserSession,
  cfg: AppConfig,
  fn: (page: Page) => Promise<T>,
): Promise<{ session: BrowserSession; value: T }> {
  let current = session;
  for (let i = 0; i < 3; i++) {
    try {
      return { session: current, value: await fn(current.page) };
    } catch (e) {
      if (!(e instanceof NeedVisibleChromeError) || shuttingDown) throw e;
      current = await revealForLogin(current, cfg, e);
    }
  }
  throw new Error("ログイン後も続行できませんでした");
}

function installInterruptLogs(): void {
  const stop = (sig: string) => {
    shuttingDown = true;
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
      ...listRawPasteRepairPdfs(cfg.workDir, cfg.onlyFilename),
      ...listEduMaterialRepairPdfs(cfg.workDir, cfg.studioGenerate, cfg.onlyFilename),
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
  log(cfg.headed ? "モード: 画面付き" : "モード: ヘッドレス（ログイン時だけ画面を出します）");

  if (items.length === 1 && isRetryCooling(loadPaperState(items[0]))) {
    const st = loadPaperState(items[0]);
    log(
      `${items[0].filename}: クールダウン中なので Chrome を開きません（${st.harvestRetryAt || st.kickoffRetryAt} まで）`,
    );
    process.exit(EXIT_WAITING);
  }

  let session = await launchBrowser(cfg);
  activeSession = session;
  const processed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  try {
    if (!(await pageAlive(session.page))) {
      session = await relaunch(session, cfg);
    }
    const existing = listExistingWorkPapers(cfg.workDir);
    log(`作業フォルダの既存 PDF名 ${existing.length} 件`);
    const repairedRun = await runCatchingLogin(session, cfg, (page) =>
      repairSciSpaceRecordLinks(page, cfg),
    );
    session = repairedRun.session;
    processed.push(...repairedRun.value.updated);
    failed.push(...repairedRun.value.failed);
    if (repairedRun.value.updated.length || repairedRun.value.failed.length) {
      log(
        `SciSpace リンク補修: 更新 ${repairedRun.value.updated.length} / 失敗 ${repairedRun.value.failed.length}`,
      );
    }
    const metaRun = await runCatchingLogin(session, cfg, (page) =>
      repairSciSpaceCardMeta(page, cfg, existing),
    );
    session = metaRun.session;
    processed.push(...metaRun.value.updated);
    failed.push(...metaRun.value.failed);
    if (metaRun.value.updated.length || metaRun.value.failed.length) {
      log(
        `SciSpace メタ補修: 更新 ${metaRun.value.updated.length} / 失敗 ${metaRun.value.failed.length}`,
      );
    }
    for (const item of items) {
      log(`--- ${item.filename} ---`);
      let r: "done" | "skipped" | "failed" | "waiting" | "quota" = "failed";
      for (let attempt = 0; attempt <= MAX_RELAUNCH; attempt++) {
        if (shuttingDown) break;
        if (!(await pageAlive(session.page))) {
          warn(`${item.filename}: ブラウザ切断を検出したため再起動します`);
          session = await relaunch(session, cfg);
        }
        const ran = await runCatchingLogin(session, cfg, (page) =>
          processOnePaper(page, cfg, item, existing),
        );
        session = ran.session;
        r = ran.value;
        if (r === "quota") break;
        if (r === "waiting") {
          if (
            shuttingDown ||
            (await pageAlive(session.page)) ||
            !studioKickoffBegun(loadPaperState(item))
          ) {
            break;
          }
          const haveVideo = videoFileReady(item.paperDir, loadPaperState(item).videoMp4Path);
          warn(
            haveVideo
              ? `${item.filename}: ブラウザ切断。同じ論文の Studio 再生成はせず、SciSpace / Edu Share を進めます`
              : `${item.filename}: ブラウザ切断。MP4 が無いので Studio から保存を再試行します`,
          );
          session = await relaunch(session, cfg);
          const ranWait = await runCatchingLogin(session, cfg, (page) =>
            processOnePaper(page, cfg, item, existing, {
              skipStudio: haveVideo,
            }),
          );
          session = ranWait.session;
          r = ranWait.value;
          break;
        }
        if (r !== "failed" || (await pageAlive(session.page)) || attempt >= MAX_RELAUNCH || shuttingDown) {
          break;
        }
        const paperState = loadPaperState(item);
        if (studioKickoffBegun(paperState) || isTargetClosedMessage(paperState.lastError)) {
          const haveVideo = videoFileReady(item.paperDir, paperState.videoMp4Path);
          warn(
            haveVideo
              ? `${item.filename}: ブラウザ切断。同じ論文の Studio 再生成はせず、SciSpace / Edu Share を進めます`
              : `${item.filename}: ブラウザ切断。MP4 が無いので Studio から保存を再試行します`,
          );
          session = await relaunch(session, cfg);
          const ranFail = await runCatchingLogin(session, cfg, (page) =>
            processOnePaper(page, cfg, item, existing, { skipStudio: haveVideo }),
          );
          session = ranFail.session;
          r = ranFail.value;
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
      } else if (r === "quota") {
        log(`${item.filename}: Notebook 利用量のため Chrome を明け渡します`);
        process.exitCode = EXIT_QUOTA;
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
      process.exitCode === EXIT_WAITING ? " / 生成待ち" : process.exitCode === EXIT_QUOTA ? " / 利用量待ち" : ""
    }`,
  );
  if (failed.length) {
    logError(`失敗: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  logError(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
