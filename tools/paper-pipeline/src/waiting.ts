import type { StageId } from "./state.ts";

/** worker が生成待ちで Chrome を明け渡したときの終了コード */
export const EXIT_WAITING = 10;

export class GenerationWaitingError extends Error {
  constructor(readonly stage: StageId) {
    super(`Studio 生成待ちのため一旦明け渡します（${stage}）`);
    this.name = "GenerationWaitingError";
  }
}

export function recheckDelayMs(stage: string): number {
  if (stage === "nlm-video") return 60_000;
  if (stage === "nlm-slides") return 90_000;
  if (stage === "nlm-quiz" || stage === "nlm-flashcards") return 20_000;
  return 30_000;
}

export function isStudioStage(stage: string): stage is StageId {
  return (
    stage === "nlm-slides" ||
    stage === "nlm-video" ||
    stage === "nlm-quiz" ||
    stage === "nlm-flashcards"
  );
}

/** 生成ボタンを押してから UI に出力が出るまでの猶予。ここを過ぎてもカードが無ければ判断し直す */
export const GENERATION_START_GRACE_MS = 20 * 60 * 1000;
/** Studio が空のままの論文を、生成待ちの 60s 間隔で開き直さない */
export const STUDIO_EMPTY_REVISIT_MS = 15 * 60 * 1000;
/** この時間を過ぎても出力カードが無ければ開始記録を捨ててキックオフし直す */
export const STUDIO_EMPTY_UNMARK_MS = 60 * 60 * 1000;
/** MP4 取得失敗・SciSpace メタが前に進まないときの最初の間隔 */
export const HARVEST_RETRY_BASE_MS = 5 * 60 * 1000;
export const HARVEST_RETRY_MAX_MS = 2 * 60 * 60 * 1000;

export type HarvestRetryState = {
  harvestRetryAt?: string;
  harvestFailures?: number;
  kickoffRetryAt?: string;
};

export function harvestBackoffMs(failures: number): number {
  const n = Math.max(0, Math.min(failures, 6));
  return Math.min(HARVEST_RETRY_MAX_MS, HARVEST_RETRY_BASE_MS * 3 ** n);
}

export function retryUntilMs(state: HarvestRetryState, now = Date.now()): number {
  return Math.max(
    Date.parse(state.harvestRetryAt || "") || 0,
    Date.parse(state.kickoffRetryAt || "") || 0,
  );
}

export function isRetryCooling(state: HarvestRetryState, now = Date.now()): boolean {
  return retryUntilMs(state, now) > now;
}

export function applyHarvestFailure(state: HarvestRetryState, now = Date.now()): number {
  const failures = Math.max(0, Math.floor(Number(state.harvestFailures) || 0)) + 1;
  state.harvestFailures = failures;
  const wait = harvestBackoffMs(failures - 1);
  state.harvestRetryAt = new Date(now + wait).toISOString();
  return wait;
}

export function clearHarvestRetry(state: HarvestRetryState): void {
  state.harvestFailures = 0;
  state.harvestRetryAt = "";
}

export type IncompleteStudioDecision = "keep" | "cooldown" | "unmark";

/** ツールバーだけの Studio を、読み込み中と本当に空な状態で分ける */
export function decideIncompleteStudioScan(opts: {
  generationStartedAt: string;
  generating: boolean;
  now?: number;
}): IncompleteStudioDecision {
  const now = opts.now ?? Date.now();
  const t = Date.parse(opts.generationStartedAt || "");
  const age = Number.isFinite(t) && t > 0 ? now - t : Number.POSITIVE_INFINITY;
  if (age < GENERATION_START_GRACE_MS) return "keep";
  if (opts.generating && age < STUDIO_EMPTY_UNMARK_MS) return "keep";
  if (age < STUDIO_EMPTY_UNMARK_MS) return "cooldown";
  return "unmark";
}
