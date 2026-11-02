import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  filterDuplicateInboxPdfs,
  loadExistingMatchTargets,
  type MatchTarget,
} from "./content-match.ts";
import { assertConfigPaths, helpText, loadConfig, parseArgv } from "./config.ts";
import { PACKAGE_ROOT } from "./env.ts";
import { addUnregisteredInboxPdfs, hasDoneMarker, listInboxPdfs, listRawPasteRepairPdfs, type InboxPdf } from "./inbox.ts";
import { error as logError, log, warn } from "./log.ts";
import { pickNextJob, type PickResult, type SchedJob, type SchedStatus } from "./schedule.ts";
import {
  emptyState,
  isCompleted,
  loadState,
  studioKickoffBegun,
  studioKickoffSettled,
  type PaperState,
  type StudioStageId,
} from "./state.ts";
import { hasHarvestableWork, missingEduUploads } from "./harvest.ts";
import {
  currentNotebookQuotaPause,
  EXIT_QUOTA,
  fmtPct,
  formatJst,
  waitUntilNotebookQuotaAllows,
  type NotebookQuotaPause,
} from "./notebook-quota.ts";
import { EXIT_WAITING, EXIT_WAITING_TIMEOUT, recheckDelayMs, retryUntilMs } from "./waiting.ts";
import { needsLocalVideoFile } from "./video-file.ts";
import { needsSciSpaceCardRecapture } from "./scispace-card.ts";
import { isTargetClosedMessage } from "./browser.ts";
import { formatStudioGenerateArg, formatStudioGenerateJa, missingStudioStages } from "./studio-select.ts";

import { EXIT_LOGIN_REQUIRED } from "./human.ts";
import { persistGiveUp, prepareGivenUp, emptyGiveUpTrack, holdWaiting, noteDisconnect, noteFailRound, noteWaiting, type GiveUpTrack } from "./give-up.ts";

const MAX_FAIL_RETRIES = 3;
const CHROME_UNLOCK_MS = 2_500;

type Track = {
  item: InboxPdf;
  retries: number;
  fromUsed: boolean;
  giveUp: GiveUpTrack;
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

export function resolveWorkerSpawn(
  args: string[],
  opts?: { metaUrl?: string; distCliExists?: boolean },
): { command: string; spawnArgs: string[] } {
  const metaUrl = opts?.metaUrl ?? import.meta.url;
  const isBuiltJs = metaUrl.endsWith(".js");
  const distCli = join(PACKAGE_ROOT, "dist/cli.js");
  const hasDistCli = opts?.distCliExists !== undefined ? opts.distCliExists : existsSync(distCli);
  if (isBuiltJs && hasDistCli) {
    return {
      command: process.execPath,
      spawnArgs: [distCli, ...args],
    };
  }
  return {
    command: process.execPath,
    spawnArgs: [
      join(PACKAGE_ROOT, "node_modules/tsx/dist/cli.mjs"),
      join(PACKAGE_ROOT, "src/cli.ts"),
      ...args,
    ],
  };
}

function runWorker(args: string[]): Promise<number> {
  const { command, spawnArgs } = resolveWorkerSpawn(args);
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      spawnArgs,
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

function applyKickoff(
  job: SchedJob,
  state: PaperState,
  skip: readonly StudioStageId[],
  selected: readonly StudioStageId[],
): void {
  job.kickoffBegun = studioKickoffBegun(state, skip);
  job.kickoffSettled = studioKickoffSettled(state, skip);
  job.harvestable = hasHarvestableWork(state, selected);
}

function initialStatus(
  item: InboxPdf,
  skip: readonly StudioStageId[],
  selected: readonly StudioStageId[],
  retryGivenUp = false,
): {
  status: SchedStatus;
  nextCheckAt: number;
  kickoffBegun: boolean;
  kickoffSettled: boolean;
  harvestable: boolean;
} {
  const state = loadPaperState(item);
  const kickoffBegun = studioKickoffBegun(state, skip);
  const kickoffSettled = studioKickoffSettled(state, skip);
  const harvestable = hasHarvestableWork(state, selected);
  if (prepareGivenUp(state, retryGivenUp)) {
    log(`オーケストレータ: ${item.filename} は打ち切り済みのためスキップ（${state.giveUp!.reason}）`);
    return { status: "skipped", nextCheckAt: 0, kickoffBegun, kickoffSettled, harvestable: false };
  }
  const coolUntil = retryUntilMs(state);
  if (coolUntil > Date.now()) {
    return { status: "waiting", nextCheckAt: coolUntil, kickoffBegun, kickoffSettled, harvestable };
  }
  if (hasDoneMarker(item.paperDir)) {
    if (
      needsLocalVideoFile(state) ||
      needsSciSpaceCardRecapture(state) ||
      missingEduUploads(state, selected).length > 0 ||
      missingStudioStages(state, selected).length > 0
    ) {
      return { status: "ready", nextCheckAt: 0, kickoffBegun, kickoffSettled, harvestable: true };
    }
    return { status: "done", nextCheckAt: 0, kickoffBegun, kickoffSettled, harvestable: false };
  }
  if (state.skippedAlreadyUploaded) {
    return { status: "skipped", nextCheckAt: 0, kickoffBegun, kickoffSettled, harvestable: false };
  }
  if (state.waitingFor && isCompleted(state, state.waitingFor)) {
    return { status: "ready", nextCheckAt: 0, kickoffBegun, kickoffSettled, harvestable };
  }
  if (state.waitingFor && kickoffSettled) {
    return { status: "waiting", nextCheckAt: Date.now(), kickoffBegun, kickoffSettled, harvestable };
  }
  return { status: "ready", nextCheckAt: 0, kickoffBegun, kickoffSettled, harvestable };
}

export { EXIT_WAITING_TIMEOUT };

export type WaitingPaperInfo = {
  filename: string;
  stage: string;
};

export type IdleQuotaAction =
  | { action: "exit"; pause: NotebookQuotaPause; pendingPapers: number }
  | { action: "exit_waiting"; waitingPapers: WaitingPaperInfo[]; elapsedMinutes: number }
  | { action: "wait_quota" }
  | { action: "sleep"; sleepMs: number; generationBlocked: boolean };

export function decideIdleAction(
  pick: PickResult,
  opts: {
    generationBlocked: boolean;
    jobs: readonly SchedJob[];
    exitOnQuota: boolean;
    pause?: NotebookQuotaPause | null;
    maxWaitingMinutes?: number;
    waitingSince?: number;
    now?: number;
    getWaitingStage?: (filename: string) => string;
  },
): IdleQuotaAction | null {
  if (pick.kind !== "idle") return null;
  const hasHarvestable = opts.jobs.some(
    (j) => j.harvestable && (j.status === "ready" || j.status === "waiting"),
  );
  if (opts.generationBlocked && !hasHarvestable) {
    if (opts.exitOnQuota) {
      const pendingPapers = opts.jobs.filter(
        (j) => j.status === "ready" || j.status === "waiting",
      ).length;
      const pause: NotebookQuotaPause = opts.pause ?? {
        reason: "short",
        until: null,
        untilLabel: "",
        used: 100,
        stopPercent: 85,
      };
      return { action: "exit", pause, pendingPapers };
    }
    return { action: "wait_quota" };
  }
  const maxWaitingMinutes = opts.maxWaitingMinutes ?? 0;
  const waitingSince = opts.waitingSince ?? 0;
  const now = opts.now ?? Date.now();
  if (maxWaitingMinutes > 0 && waitingSince > 0 && !hasHarvestable) {
    const elapsedMs = now - waitingSince;
    if (elapsedMs >= maxWaitingMinutes * 60_000) {
      const waitingPapers: WaitingPaperInfo[] = opts.jobs
        .filter((j) => j.status === "waiting")
        .map((j) => ({
          filename: j.id,
          stage: opts.getWaitingStage ? opts.getWaitingStage(j.id) : "不明",
        }));
      const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
      return { action: "exit_waiting", waitingPapers, elapsedMinutes };
    }
  }
  return {
    action: "sleep",
    sleepMs: pick.sleepMs,
    generationBlocked: opts.generationBlocked,
  };
}

export function getPaperWaitingStage(state: PaperState): string {
  return (
    state.waitingFor ||
    state.kickoffRetryStage ||
    (state.completed.includes("nlm-upload") ? "nlm-video" : "nlm-upload")
  );
}

export function detectProgress(
  before: PaperState,
  after: PaperState,
  code: number,
): boolean {
  if (code === 0) return true;
  if (after.completed.length > before.completed.length) return true;
  if (!before.videoMp4Path && Boolean(after.videoMp4Path)) return true;
  if (!before.slidePdfPath && Boolean(after.slidePdfPath)) return true;
  if (!before.quizCsvPath && Boolean(after.quizCsvPath)) return true;
  if (!before.vocabCsvPath && Boolean(after.vocabCsvPath)) return true;
  return false;
}

export function formatExitOnWaitingMessage(
  waitingPapers: WaitingPaperInfo[],
  elapsedMinutes: number,
): string {
  const waitingDesc =
    waitingPapers.length > 0
      ? waitingPapers.map((p) => `${p.filename} (${p.stage})`).join(", ")
      : "なし";
  return `オーケストレータ: 進められる作業がなく、生成待ちが ${elapsedMinutes} 分続いたため終了します（待機中: ${waitingDesc}）`;
}

export function formatExitOnQuotaMessage(
  pause: NotebookQuotaPause,
  pendingCount: number,
): string {
  const kindLabel = pause.reason === "weekly" ? "週枠" : "短期枠";
  const resetLabel = pause.untilLabel || (pause.until ? formatJst(pause.until) : "未定");
  return `オーケストレータ: --exit-on-quota により終了します（枠: ${kindLabel}、使用率: ${fmtPct(pause.used)}%、リセット時刻: ${resetLabel}、途中の論文: ${pendingCount} 件）`;
}

function orchHelp(): string {
  return `${helpText()}
呼び出し側:
  npm start は inbox 直下の PDF だけを、worker（1論文・1 Chrome）で順に処理します。
  作業フォルダの SciSpace メタ補修は npm run repair-meta です。inbox に無い論文は対象にしません。
  --generate で slides / video / quiz / flashcards を選べます（複数可、all で全部）。
  指定した項目が生成待ちか完了になるまで、次の論文の生成には進みません。
  SciSpace への PDF 掲載は NotebookLM より先に行い、カードメタは Studio 後に取ります。
  Studio の生成（スライド・解説動画・クイズ・単語帳）が揃った論文は SciSpace メタ / Edu Share へ進みます。
  動画 MP4 は NotebookLM のダウンロードボタンで保存して Edu Share に載せます。
  同じ Chrome プロファイルは同時に使いません。npm start と npm run repair-meta も同時には起動しません。
  Notebook の短期枠の使用量が上限（既定 85%、--notebook-short-stop-percent で変更）を超えているあいだは生成を止め、週枠が 100% ならリセット時刻まで待ちます。
  そのあいだは SciSpace 掲載・メタ、できている生成物の Edu Share 登録を先に進めます。
  MP4 が取れない・Studio が空・SciSpace メタが進まないときは同じ論文をすぐ開き直さず、間隔を空けます。

  npm start
  npm start -- --headless
  npm run repair-meta -- --headed
  npm run worker -- --only paper.pdf

  --exit-on-quota は利用枠が上限に達し進められる作業が無くなったときにリセットを待たず終了コード 11 で終了します（環境変数 NOTEBOOK_EXIT_ON_QUOTA=1 でも可）。
  --retry-given-up は打ち切り済みを再開（--only FILE.pdf 併用ならその論文だけ）。
  --headless はウィンドウなし。ログインや追加確認のときだけ画面を出します。
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

  const repairMeta = argv.includes("--repair-meta");
  const retryGivenUp = argv.includes("--retry-given-up");
  const rawItems = repairMeta
    ? listRawPasteRepairPdfs(cfg.workDir, cfg.onlyFilename)
    : listInboxPdfs(cfg.inboxDir, cfg.workDir, cfg.onlyFilename);

  const matchTargets: MatchTarget[] = repairMeta
    ? []
    : await loadExistingMatchTargets(cfg.workDir, cfg.duplicatesDir);
  const items = repairMeta
    ? rawItems
    : await filterDuplicateInboxPdfs(rawItems, matchTargets, cfg.holdDir);

  if (cfg.onlyFilename && items.length === 0) {
    log(
      repairMeta
        ? `作業フォルダにメタ補修対象の ${cfg.onlyFilename} はありません`
        : `inbox に ${cfg.onlyFilename} はありません`,
    );
  }
  log(
    repairMeta
      ? `オーケストレータ: メタ補修 ${items.length} 件（${cfg.headed ? "画面付き" : "ヘッドレス"}）`
      : `オーケストレータ: inbox ${items.length} 件（Studio ${formatStudioGenerateJa(cfg.studioGenerate)} / ${
          cfg.headed ? "画面付き" : "ヘッドレス"
        }）`,
  );

  const skip = studioSkip(cfg);
  const tracks = new Map<string, Track>();
  const registeredPaths = new Set<string>();
  const jobs: SchedJob[] = [];
  const addItems = (newItems: InboxPdf[]) => addUnregisteredInboxPdfs(newItems, registeredPaths, (item) => {
    tracks.set(item.filename, { item, retries: 0, fromUsed: false, giveUp: emptyGiveUpTrack() });
    const init = initialStatus(item, skip, cfg.studioGenerate, retryGivenUp);
    jobs.push({
      id: item.filename,
      mtime: cfg.newestFirst ? -mtimeMs(item.absPath) : mtimeMs(item.absPath),
      status: init.status,
      nextCheckAt: init.nextCheckAt,
      attempts: 0,
      source: repairMeta ? "repair" : "inbox",
      kickoffBegun: init.kickoffBegun,
      kickoffSettled: init.kickoffSettled,
      harvestable: init.harvestable,
    });
    log(`オーケストレータ: worker 対象を追加 → ${item.filename}`);
  });
  addItems(items);
  const refreshInbox = async () => {
    if (repairMeta || cfg.onlyFilename) return 0;
    const current = listInboxPdfs(cfg.inboxDir, cfg.workDir);
    const valid = await filterDuplicateInboxPdfs(current, matchTargets, cfg.holdDir);
    return addItems(valid);
  };

  const processed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let exitedOnQuota = false;
  let exitedOnWaitingTimeout = false;
  let loginRequired = false;
  let waitingSince = 0;

  while (true) {
    await refreshInbox();
    const pause = await currentNotebookQuotaPause(cfg);
    const generationBlocked = pause != null;
    const pick = pickNextJob(jobs, Date.now(), { generationBlocked });
    if (pick.kind === "done") {
      if ((await refreshInbox()) > 0) continue;
      break;
    }
    if (pick.kind === "idle") {
      if (waitingSince === 0) {
        waitingSince = Date.now();
      }
      const decision = decideIdleAction(pick, {
        generationBlocked,
        jobs,
        exitOnQuota: cfg.exitOnQuota,
        pause,
        maxWaitingMinutes: cfg.maxWaitingMinutes,
        waitingSince,
        getWaitingStage: (filename) => {
          const t = tracks.get(filename);
          if (t) {
            const st = loadPaperState(t.item);
            return getPaperWaitingStage(st);
          }
          return "不明";
        },
      });
      if (decision?.action === "exit") {
        log(formatExitOnQuotaMessage(decision.pause, decision.pendingPapers));
        exitedOnQuota = true;
        break;
      }
      if (decision?.action === "exit_waiting") {
        log(formatExitOnWaitingMessage(decision.waitingPapers, decision.elapsedMinutes));
        exitedOnWaitingTimeout = true;
        break;
      }
      if (decision?.action === "wait_quota") {
        log("オーケストレータ: 利用量のため生成は止め、他に進められる論文もありません");
        await waitUntilNotebookQuotaAllows(cfg);
        continue;
      }
      const sec = Math.ceil(pick.sleepMs / 1000);
      log(
        generationBlocked
          ? `オーケストレータ: 利用量回復待ち。先に進められる作業の再確認まで約 ${sec}s`
          : `オーケストレータ: 生成待ちのため約 ${sec}s 休みます`,
      );
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
    if (cfg.noRevealLogin) args.push("--no-reveal-login");
    if (cfg.newestFirst) args.push("--newest-first");
    if (cfg.fromStage && cfg.onlyFilename === track.item.filename && !track.fromUsed) {
      args.push("--from", cfg.fromStage);
      track.fromUsed = true;
    }

    log(
      generationBlocked
        ? `オーケストレータ: 利用量待ちのため生成以外を進めます → ${track.item.filename}`
        : `オーケストレータ: worker を呼びます → ${track.item.filename}`,
    );
    const stateBefore = loadPaperState(track.item);

    const code = await runWorker(args);
    await sleep(CHROME_UNLOCK_MS);

    const stateAfter = loadPaperState(track.item);
    const progressMade = detectProgress(stateBefore, stateAfter, code);

    if (progressMade) {
      waitingSince = 0;
    } else if (waitingSince === 0) {
      waitingSince = Date.now();
    }

    if (code === EXIT_LOGIN_REQUIRED) {
      loginRequired = true;
      logError(
        `オーケストレータ: ${track.item.filename} でログインまたは追加確認が必要です。--no-reveal-login のためパイプラインを終了します`,
      );
      break;
    }

    if (code === EXIT_QUOTA) {
      const state = loadPaperState(track.item);
      applyKickoff(job, state, skip, cfg.studioGenerate);
      holdWaiting(track.giveUp, Date.now());
      job.status = "waiting";
      job.nextCheckAt = Date.now() + 60_000;
      log(
        job.harvestable
          ? `オーケストレータ: ${track.item.filename} は利用量待ち。できた作業は載せました。他の論文を先に回します`
          : `オーケストレータ: ${track.item.filename} は Notebook 利用量のため生成を止めます。他にできる作業を先に回します`,
      );
      continue;
    }

    if (code === EXIT_WAITING) {
      const state = loadPaperState(track.item);
      applyKickoff(job, state, skip, cfg.studioGenerate);
      const stage = getPaperWaitingStage(state);
      const cooldownUntil = retryUntilMs(state);
      const limitHint =
        cooldownUntil > Date.now() &&
        state.kickoffRetryStage === stage &&
        state.lastError &&
        /日次上限|後で生成/.test(state.lastError)
          ? `（${state.lastError}）`
          : "";
      if (generationBlocked || cooldownUntil > Date.now()) {
        holdWaiting(track.giveUp, Date.now());
      } else if (noteWaiting(track.giveUp, stage, Date.now())) {
        persistGiveUp(loadPaperState(track.item), `${stage} 待ちが長時間続きました`);
        job.status = "failed";
        failed.push(track.item.filename);
        warn(
          `オーケストレータ: ${track.item.filename} は ${stage} 待ちが長く続いたのであきらめます。ほかの論文を続けます`,
        );
        continue;
      }
      if (!job.kickoffSettled && !generationBlocked && cooldownUntil <= Date.now()) {
        job.status = "ready";
        job.nextCheckAt = 0;
        log(
          `オーケストレータ: ${track.item.filename} は ${stage} 待ちだが指定した Studio が揃っていないので同じ論文を続けます`,
        );
        continue;
      }
      job.status = "waiting";
      job.nextCheckAt =
        cooldownUntil > Date.now() ? cooldownUntil : Date.now() + recheckDelayMs(stage);
      log(
        generationBlocked
          ? `オーケストレータ: ${track.item.filename} は生成待ち。利用量回復までは他の論文の SciSpace / Edu Share を進めます`
          : cooldownUntil > Date.now()
            ? `オーケストレータ: ${track.item.filename} は ${stage} 開始クールダウン${limitHint}。他の論文の SciSpace / Edu Share を進めます`
            : `オーケストレータ: ${track.item.filename} は ${stage} 待ち（指定項目は開始済み）。次の論文の生成へ`,
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

    applyKickoff(job, loadPaperState(track.item), skip, cfg.studioGenerate);
    const disconnected = isTargetClosedMessage(loadPaperState(track.item).lastError);
    if (disconnected) {
      if (noteDisconnect(track.giveUp)) {
        persistGiveUp(loadPaperState(track.item), "ブラウザ切断が上限に達しました");
        job.status = "failed";
        failed.push(track.item.filename);
        warn(`オーケストレータ: ${track.item.filename} はブラウザ切断が続いたのであきらめます。ほかの論文を続けます`);
        continue;
      }
      job.status = "waiting";
      job.nextCheckAt = Date.now() + 60_000;
      log(
        `オーケストレータ: ${track.item.filename} はブラウザ切断。Studio 再生成はせず、他の論文の SciSpace / Edu Share を先に回します`,
      );
      continue;
    }
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
      if (noteFailRound(track.giveUp)) {
        persistGiveUp(loadPaperState(track.item), "失敗回数が上限に達しました");
        job.status = "failed";
        failed.push(track.item.filename);
        warn(`オーケストレータ: ${track.item.filename} は失敗が続いたのであきらめます。ほかの論文を続けます`);
        continue;
      }
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
    `オーケストレータ結果: 完了 ${processed.length} / スキップ ${skipped.length} / 失敗 ${failed.length}${
      exitedOnQuota
        ? " / 利用量終了"
        : exitedOnWaitingTimeout
          ? " / 生成待ち終了"
          : loginRequired
            ? " / ログイン必要"
            : ""
    }`,
  );
  const exitCode = decideOrchestratorExitCode({
    loginRequired,
    exitedOnQuota,
    exitedOnWaitingTimeout,
    failedCount: failed.length,
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
  if (!loginRequired && !exitedOnQuota && !exitedOnWaitingTimeout && failed.length) {
    logError(`失敗: ${failed.join(", ")}`);
  }
}

export function decideOrchestratorExitCode(opts: {
  loginRequired?: boolean;
  exitedOnQuota?: boolean;
  exitedOnWaitingTimeout?: boolean;
  failedCount?: number;
}): number {
  if (opts.loginRequired) return EXIT_LOGIN_REQUIRED;
  if (opts.exitedOnQuota) return EXIT_QUOTA;
  if (opts.exitedOnWaitingTimeout) return EXIT_WAITING_TIMEOUT;
  if (opts.failedCount && opts.failedCount > 0) return 1;
  return 0;
}

export function isMainModule(
  metaUrl: string = import.meta.url,
  scriptPath: string | null = process.argv[1] ?? null,
): boolean {
  if (!scriptPath) return false;
  try {
    return realpathSync(scriptPath) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main()
    .then(() => {
      if (process.exitCode !== undefined && process.exitCode !== 0) {
        process.exit(process.exitCode);
      }
    })
    .catch((e) => {
      logError(e instanceof Error ? e.stack ?? e.message : String(e));
      process.exit(1);
    });
}
