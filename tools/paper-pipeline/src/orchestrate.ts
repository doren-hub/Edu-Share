import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { assertConfigPaths, helpText, loadConfig, parseArgv } from "./config.ts";
import { PACKAGE_ROOT } from "./env.ts";
import { hasDoneMarker, listInboxPdfs, listStudioFollowupPdfs, listVideoRepairPdfs, listWorkPdfs, mergeInboxAndVideoRepair, type InboxPdf } from "./inbox.ts";
import { error as logError, log, warn } from "./log.ts";
import { pickNextJob, type SchedJob, type SchedStatus } from "./schedule.ts";
import {
  emptyState,
  loadState,
  studioKickoffBegun,
  studioKickoffSettled,
  type PaperState,
  type StudioStageId,
} from "./state.ts";
import { EXIT_WAITING, recheckDelayMs } from "./waiting.ts";
import { needsLocalVideoFile } from "./video-file.ts";
import { formatStudioGenerateArg, formatStudioGenerateJa } from "./studio-select.ts";

const MAX_FAIL_RETRIES = 3;
const CHROME_UNLOCK_MS = 1_500;

type Track = {
  item: InboxPdf;
  retries: number;
  fromUsed: boolean;
};

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function runWorker(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(PACKAGE_ROOT, "node_modules/tsx/dist/cli.mjs"),
        join(PACKAGE_ROOT, "src/cli.ts"),
        ...args,
      ],
      { cwd: PACKAGE_ROOT, stdio: "inherit", env: process.env },
    );
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

function loadPaperState(item: InboxPdf): PaperState {
  return loadState(
    item.paperDir,
    emptyState({
      filename: item.filename,
      inboxPdfPath: item.absPath,
      paperDir: item.paperDir,
    }),
  );
}

function studioSkip(cfg: { studioSkip: readonly StudioStageId[] }): readonly StudioStageId[] {
  return cfg.studioSkip;
}

function applyKickoff(job: SchedJob, state: PaperState, skip: readonly StudioStageId[]): void {
  job.kickoffBegun = studioKickoffBegun(state, skip);
  job.kickoffSettled = studioKickoffSettled(state, skip);
}

function initialStatus(
  item: InboxPdf,
  skip: readonly StudioStageId[],
): { status: SchedStatus; nextCheckAt: number; kickoffBegun: boolean; kickoffSettled: boolean } {
  const state = loadPaperState(item);
  const kickoffBegun = studioKickoffBegun(state, skip);
  const kickoffSettled = studioKickoffSettled(state, skip);
  if (hasDoneMarker(item.paperDir)) {
    if (needsLocalVideoFile(state)) {
      return { status: "ready", nextCheckAt: 0, kickoffBegun, kickoffSettled };
    }
    return { status: "done", nextCheckAt: 0, kickoffBegun, kickoffSettled };
  }
  if (state.skippedAlreadyUploaded) {
    return { status: "skipped", nextCheckAt: 0, kickoffBegun, kickoffSettled };
  }
  if (state.waitingFor && kickoffSettled) {
    return { status: "waiting", nextCheckAt: Date.now(), kickoffBegun, kickoffSettled };
  }
  return { status: "ready", nextCheckAt: 0, kickoffBegun, kickoffSettled };
}

function orchHelp(): string {
  return `${helpText()}
呼び出し側（既定の npm start）:
  既存の worker（1論文・1 Chrome）を順に呼びます。
  --generate で slides / video / quiz / flashcards を選べます（複数可、all で全部）。
  指定した項目が生成待ちか完了になるまで、次の論文の生成には進みません。
  Edu Share 済みの論文にも、足りない項目を後から生成できます。
  SciSpace への PDF 掲載は NotebookLM より先に行い、カードメタは Studio 後に取ります。
  Studio の生成（スライド・解説動画・クイズ・単語帳）が揃った論文は SciSpace メタ / Edu Share へ進みます。
  動画 MP4 は NotebookLM のダウンロードボタンで保存して Edu Share に載せます。
  同じ Chrome プロファイルは同時に使いません。

  npm start
  npm run worker -- --only paper.pdf
`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(orchHelp());
    return;
  }
  const overrides = parseArgv(argv);
  const cfg = loadConfig(overrides);
  assertConfigPaths(cfg);

  const inbox = listInboxPdfs(cfg.inboxDir, cfg.workDir, cfg.onlyFilename);
  const inboxNames = new Set(inbox.map((i) => i.filename));
  const extras = [
    ...listVideoRepairPdfs(cfg.workDir, cfg.onlyFilename),
    ...listWorkPdfs(cfg.workDir, cfg.onlyFilename),
    ...(cfg.studioGenerateExplicit
      ? listStudioFollowupPdfs(cfg.workDir, cfg.studioGenerate, cfg.onlyFilename)
      : []),
  ];
  const items = mergeInboxAndVideoRepair(inbox, extras);
  if (cfg.onlyFilename && items.length === 0) {
    log(`入力ディレクトリに ${cfg.onlyFilename} はありません`);
  }
  log(
    `オーケストレータ: 入力 ${items.length} 件（Studio ${formatStudioGenerateJa(cfg.studioGenerate)}）`,
  );

  const skip = studioSkip(cfg);
  const tracks = new Map<string, Track>();
  const jobs: SchedJob[] = items.map((item) => {
    tracks.set(item.filename, { item, retries: 0, fromUsed: false });
    const init = initialStatus(item, skip);
    return {
      id: item.filename,
      mtime: mtimeMs(item.absPath),
      status: init.status,
      nextCheckAt: init.nextCheckAt,
      attempts: 0,
      source: inboxNames.has(item.filename) ? "inbox" : "repair",
      kickoffBegun: init.kickoffBegun,
      kickoffSettled: init.kickoffSettled,
    };
  });

  const processed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  while (true) {
    const pick = pickNextJob(jobs, Date.now());
    if (pick.kind === "done") break;
    if (pick.kind === "idle") {
      const sec = Math.ceil(pick.sleepMs / 1000);
      log(`オーケストレータ: 生成待ちのため約 ${sec}s 休みます`);
      await sleep(Math.min(pick.sleepMs, 60_000));
      continue;
    }

    const job = jobs.find((j) => j.id === pick.id);
    const track = tracks.get(pick.id);
    if (!job || !track) {
      warn(`オーケストレータ: ${pick.id} の追跡がありません`);
      break;
    }

    const args = [cfg.headed ? "--headed" : "--headless", "--only", track.item.filename];
    if (cfg.studioGenerateExplicit) {
      args.push("--generate", formatStudioGenerateArg(cfg.studioGenerate));
    }
    if (cfg.fromStage && cfg.onlyFilename === track.item.filename && !track.fromUsed) {
      args.push("--from", cfg.fromStage);
      track.fromUsed = true;
    }

    log(`オーケストレータ: worker を呼びます → ${track.item.filename}`);
    const code = await runWorker(args);
    await sleep(CHROME_UNLOCK_MS);

    if (code === EXIT_WAITING) {
      const state = loadPaperState(track.item);
      applyKickoff(job, state, skip);
      const stage = state.waitingFor || "nlm-video";
      if (!job.kickoffSettled) {
        job.status = "ready";
        job.nextCheckAt = 0;
        log(
          `オーケストレータ: ${track.item.filename} は ${stage} 待ちだが指定した Studio が揃っていないので同じ論文を続けます`,
        );
        continue;
      }
      job.status = "waiting";
      job.nextCheckAt = Date.now() + recheckDelayMs(stage);
      log(
        `オーケストレータ: ${track.item.filename} は ${stage} 待ち（指定項目は開始済み）。次の論文の生成へ`,
      );
      continue;
    }

    if (code === 0) {
      if (hasDoneMarker(track.item.paperDir)) {
        job.status = "done";
        processed.push(track.item.filename);
      } else {
        job.status = "skipped";
        skipped.push(track.item.filename);
      }
      continue;
    }

    applyKickoff(job, loadPaperState(track.item), skip);
    track.retries += 1;
    warn(
      job.kickoffBegun && !job.kickoffSettled
        ? `オーケストレータ: ${track.item.filename} が失敗（${track.retries}/${MAX_FAIL_RETRIES}）。指定した Studio が揃うまで同じ論文を先に回します`
        : `オーケストレータ: ${track.item.filename} が失敗（${track.retries}/${MAX_FAIL_RETRIES}）。他の論文を先に回します`,
    );
    if (cfg.stopOnError) {
      job.status = "failed";
      failed.push(track.item.filename);
      break;
    }
    if (track.retries >= MAX_FAIL_RETRIES) {
      const delay = 120_000;
      track.retries = 0;
      job.status = "waiting";
      job.attempts = MAX_FAIL_RETRIES;
      job.nextCheckAt = Date.now() + delay;
      log(
        `オーケストレータ: ${track.item.filename} は3回失敗したので約 ${delay / 1000}s 後に再試行します`,
      );
      continue;
    }
    job.status = "ready";
    job.nextCheckAt = 0;
    job.attempts = track.retries;
  }

  log(
    `オーケストレータ結果: 完了 ${processed.length} / スキップ ${skipped.length} / 失敗 ${failed.length}`,
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
