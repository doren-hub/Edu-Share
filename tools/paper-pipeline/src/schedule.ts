export type SchedStatus = "ready" | "waiting" | "done" | "skipped" | "failed";

export type SchedJob = {
  id: string;
  mtime: number;
  status: SchedStatus;
  nextCheckAt: number;
  /** 失敗した回数。同じ論文の即再試行より、他の ready を先に回す */
  attempts: number;
  /** inbox の未完了を、完了後の MP4 補修より先に回す */
  source: "inbox" | "repair";
  /** Studio のどれかを開始した */
  kickoffBegun: boolean;
  /** スライド・動画・クイズ・単語帳がすべて開始済みか完了 */
  kickoffSettled: boolean;
  /** 利用量待ち中に SciSpace / Edu Share / 収集を進められる */
  harvestable: boolean;
};

export type PickResult =
  | { kind: "run"; id: string }
  | { kind: "idle"; sleepMs: number }
  | { kind: "done" };

function byInboxOrder(a: SchedJob, b: SchedJob): number {
  const byMtime = a.mtime - b.mtime;
  if (byMtime !== 0) return byMtime;
  return a.id.localeCompare(b.id, "en");
}

function byHarvestOrder(a: SchedJob, b: SchedJob): number {
  const bySource = Number(a.source === "inbox") - Number(b.source === "inbox");
  if (bySource !== 0) return bySource;
  const byAttempts = (a.attempts ?? 0) - (b.attempts ?? 0);
  if (byAttempts !== 0) return byAttempts;
  return byInboxOrder(a, b);
}

function byReadyOrder(a: SchedJob, b: SchedJob): number {
  const byAttempts = (a.attempts ?? 0) - (b.attempts ?? 0);
  if (byAttempts !== 0) return byAttempts;
  const bySource = Number(a.source === "repair") - Number(b.source === "repair");
  if (bySource !== 0) return bySource;
  return byInboxOrder(a, b);
}

/** 1本の Studio 4種が揃ってから次の論文の生成に進む */
export function pickNextJob(
  jobs: SchedJob[],
  now: number,
  opts: { generationBlocked?: boolean } = {},
): PickResult {
  const unfinished = jobs.filter(
    (j) => j.status === "ready" || j.status === "waiting",
  );
  if (unfinished.length === 0) return { kind: "done" };

  if (opts.generationBlocked) {
    const runnable = jobs
      .filter(
        (j) =>
          j.harvestable &&
          (j.status === "ready" || (j.status === "waiting" && j.nextCheckAt <= now)),
      )
      .sort(byHarvestOrder);
    if (runnable[0]) return { kind: "run", id: runnable[0].id };
    const waitingHarvest = jobs.filter((j) => j.harvestable && j.status === "waiting");
    if (waitingHarvest[0]) {
      const next = Math.min(...waitingHarvest.map((j) => j.nextCheckAt));
      return { kind: "idle", sleepMs: Math.max(1_000, next - now) };
    }
    return { kind: "idle", sleepMs: 60_000 };
  }

  const unsettled = unfinished
    .filter((j) => j.kickoffBegun && !j.kickoffSettled)
    .sort(byInboxOrder);
  const focus = unsettled[0];
  if (focus) {
    const harvest = jobs
      .filter(
        (j) =>
          j.id !== focus.id &&
          j.harvestable &&
          j.kickoffSettled &&
          (j.status === "ready" || (j.status === "waiting" && j.nextCheckAt <= now)),
      )
      .sort(byReadyOrder);
    if (harvest[0]) return { kind: "run", id: harvest[0].id };
    if (focus.status === "ready" || focus.nextCheckAt <= now) {
      return { kind: "run", id: focus.id };
    }
    return { kind: "idle", sleepMs: Math.max(1_000, focus.nextCheckAt - now) };
  }

  const harvestReady = jobs
    .filter((j) => j.status === "ready" && j.harvestable && j.kickoffSettled)
    .sort(byReadyOrder);
  if (harvestReady[0]) return { kind: "run", id: harvestReady[0].id };

  const ready = jobs.filter((j) => j.status === "ready").sort(byReadyOrder);
  if (ready[0]) return { kind: "run", id: ready[0].id };

  const dueWaiting = jobs
    .filter((j) => j.status === "waiting" && j.nextCheckAt <= now)
    .sort(byInboxOrder);
  if (dueWaiting[0]) return { kind: "run", id: dueWaiting[0].id };

  const waiting = jobs.filter((j) => j.status === "waiting");
  const next = Math.min(...waiting.map((j) => j.nextCheckAt));
  return { kind: "idle", sleepMs: Math.max(1_000, next - now) };
}
