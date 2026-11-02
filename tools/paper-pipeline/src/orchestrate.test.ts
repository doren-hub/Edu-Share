import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideIdleAction,
  decideOrchestratorExitCode,
  formatExitOnQuotaMessage,
  formatExitOnWaitingMessage,
  isMainModule,
  resolveWorkerSpawn,
  EXIT_WAITING_TIMEOUT,
} from "./orchestrate.ts";
import type { SchedJob } from "./schedule.ts";
import { EXIT_QUOTA, type NotebookQuotaPause } from "./notebook-quota.ts";
import { EXIT_LOGIN_REQUIRED } from "./human.ts";

function makeJob(partial: Partial<SchedJob> & Pick<SchedJob, "id">): SchedJob {
  return {
    mtime: 0,
    status: "ready",
    nextCheckAt: 0,
    attempts: 0,
    source: "inbox",
    kickoffBegun: false,
    kickoffSettled: true,
    harvestable: false,
    ...partial,
  };
}

test("resolveWorkerSpawn: 事前変換済み JS (dist) で動くときは tsx を使わず node dist/cli.js を起動する", () => {
  const result = resolveWorkerSpawn(["--only", "paper.pdf", "--headless"], {
    metaUrl: "file:///path/to/tools/paper-pipeline/dist/orchestrate.js",
    distCliExists: true,
  });

  assert.equal(result.command, process.execPath);
  assert.equal(result.spawnArgs[0].endsWith("dist/cli.js"), true);
  assert.equal(result.spawnArgs.some((arg) => arg.includes("tsx")), false);
  assert.deepEqual(result.spawnArgs.slice(1), ["--only", "paper.pdf", "--headless"]);
});

test("resolveWorkerSpawn: TypeScript 実行時または dist が無いときは tsx src/cli.ts にフォールバックする", () => {
  const fromTs = resolveWorkerSpawn(["--only", "paper.pdf"], {
    metaUrl: "file:///path/to/tools/paper-pipeline/src/orchestrate.ts",
    distCliExists: true,
  });
  assert.equal(fromTs.command, process.execPath);
  assert.equal(fromTs.spawnArgs[0].endsWith("node_modules/tsx/dist/cli.mjs"), true);
  assert.equal(fromTs.spawnArgs[1].endsWith("src/cli.ts"), true);
  assert.deepEqual(fromTs.spawnArgs.slice(2), ["--only", "paper.pdf"]);

  const noDist = resolveWorkerSpawn(["--only", "paper.pdf"], {
    metaUrl: "file:///path/to/tools/paper-pipeline/dist/orchestrate.js",
    distCliExists: false,
  });
  assert.equal(noDist.command, process.execPath);
  assert.equal(noDist.spawnArgs[0].endsWith("node_modules/tsx/dist/cli.mjs"), true);
  assert.equal(noDist.spawnArgs[1].endsWith("src/cli.ts"), true);
});

test("resolveWorkerSpawn: 引数 opts を省略した場合も実行環境に応じて起動引数を返す", () => {
  const defaultSpawn = resolveWorkerSpawn(["--only", "test.pdf"]);
  assert.equal(defaultSpawn.command, process.execPath);
  assert.equal(defaultSpawn.spawnArgs.length >= 2, true);
  assert.equal(defaultSpawn.spawnArgs.includes("--only"), true);
  assert.equal(defaultSpawn.spawnArgs.includes("test.pdf"), true);
});

test("isMainModule: 直接実行時のみ真になり、別モジュールからのインポートや未定義では偽になる", () => {
  assert.equal(isMainModule(import.meta.url, null), false);
  assert.equal(isMainModule(import.meta.url, "/non/existent/path/file.js"), false);
  assert.equal(isMainModule(), false);
  assert.equal(isMainModule(import.meta.url, fileURLToPath(import.meta.url)), true);
});

test("decideIdleAction: generationBlocked かつ収穫可能ジョブなし、exitOnQuota=true で終了 (exit)", () => {
  const pause: NotebookQuotaPause = {
    reason: "short",
    until: Date.parse("2026-11-01T15:00:00+09:00"),
    untilLabel: "2026-11-01 15:00",
    used: 92.5,
    stopPercent: 85,
  };
  const jobs = [
    makeJob({ id: "a.pdf", status: "ready", harvestable: false }),
    makeJob({ id: "b.pdf", status: "waiting", harvestable: false }),
    makeJob({ id: "c.pdf", status: "done", harvestable: false }),
    makeJob({ id: "d.pdf", status: "failed", harvestable: false }),
  ];

  const result = decideIdleAction(
    { kind: "idle", sleepMs: 60_000 },
    {
      generationBlocked: true,
      jobs,
      exitOnQuota: true,
      pause,
    },
  );

  assert.deepEqual(result, {
    action: "exit",
    pause,
    pendingPapers: 2,
  });
});

test("decideIdleAction: generationBlocked かつ収穫可能ジョブなし、exitOnQuota=false (既定) で待機 (wait_quota)", () => {
  const pause: NotebookQuotaPause = {
    reason: "short",
    until: Date.parse("2026-11-01T15:00:00+09:00"),
    untilLabel: "2026-11-01 15:00",
    used: 90,
    stopPercent: 85,
  };
  const jobs = [
    makeJob({ id: "a.pdf", status: "waiting", harvestable: false }),
  ];

  const result = decideIdleAction(
    { kind: "idle", sleepMs: 60_000 },
    {
      generationBlocked: true,
      jobs,
      exitOnQuota: false,
      pause,
    },
  );

  assert.deepEqual(result, {
    action: "wait_quota",
  });
});

test("decideIdleAction: generationBlocked かつ exitOnQuota=true でも、収穫可能作業が残っている間は exit せず sleep", () => {
  const pause: NotebookQuotaPause = {
    reason: "weekly",
    until: Date.parse("2026-11-05T12:00:00+09:00"),
    untilLabel: "2026-11-05 12:00",
    used: 100,
    stopPercent: 100,
  };

  // 1) harvestable かつ ready の論文がある場合
  const jobsWithReadyHarvest = [
    makeJob({ id: "gen.pdf", status: "waiting", harvestable: false }),
    makeJob({ id: "harvest-ready.pdf", status: "ready", harvestable: true }),
  ];
  const res1 = decideIdleAction(
    { kind: "idle", sleepMs: 5_000 },
    {
      generationBlocked: true,
      jobs: jobsWithReadyHarvest,
      exitOnQuota: true,
      pause,
    },
  );
  assert.deepEqual(res1, {
    action: "sleep",
    sleepMs: 5_000,
    generationBlocked: true,
  });

  // 2) harvestable かつ waiting（クールダウン待ち等）の論文がある場合
  const jobsWithWaitingHarvest = [
    makeJob({ id: "gen.pdf", status: "waiting", harvestable: false }),
    makeJob({ id: "harvest-wait.pdf", status: "waiting", harvestable: true }),
  ];
  const res2 = decideIdleAction(
    { kind: "idle", sleepMs: 15_000 },
    {
      generationBlocked: true,
      jobs: jobsWithWaitingHarvest,
      exitOnQuota: true,
      pause,
    },
  );
  assert.deepEqual(res2, {
    action: "sleep",
    sleepMs: 15_000,
    generationBlocked: true,
  });
});

test("decideIdleAction: generationBlocked=false の通常アイドルでは通常 sleep", () => {
  const jobs = [
    makeJob({ id: "a.pdf", status: "waiting", harvestable: false }),
  ];
  const result = decideIdleAction(
    { kind: "idle", sleepMs: 10_000 },
    {
      generationBlocked: false,
      jobs,
      exitOnQuota: true,
    },
  );
  assert.deepEqual(result, {
    action: "sleep",
    sleepMs: 10_000,
    generationBlocked: false,
  });
});

test("formatExitOnQuotaMessage: 短期枠・週枠のラベル、使用率、リセット時刻、途中の論文数を出力する", () => {
  const shortPause: NotebookQuotaPause = {
    reason: "short",
    until: Date.parse("2026-11-01T15:30:00+09:00"),
    untilLabel: "2026-11-01 15:30",
    used: 88.5,
    stopPercent: 85,
  };
  const msgShort = formatExitOnQuotaMessage(shortPause, 3);
  assert.ok(msgShort.includes("短期枠"), "短期枠を含む");
  assert.ok(msgShort.includes("88.5%"), "使用率を含む");
  assert.ok(msgShort.includes("2026-11-01 15:30"), "リセット時刻を含む");
  assert.ok(msgShort.includes("途中の論文: 3 件"), "途中の論文数を含む");

  const weeklyPause: NotebookQuotaPause = {
    reason: "weekly",
    until: Date.parse("2026-11-08T10:00:00+09:00"),
    untilLabel: "",
    used: 100,
    stopPercent: 100,
  };
  const msgWeekly = formatExitOnQuotaMessage(weeklyPause, 0);
  assert.ok(msgWeekly.includes("週枠"), "週枠を含む");
  assert.ok(msgWeekly.includes("100%"), "使用率を含む");
  assert.ok(msgWeekly.includes("2026-11-08 10:00"), "formatJst によるリセット時刻を含む");
  assert.ok(msgWeekly.includes("途中の論文: 0 件"), "途中の論文数を含む");
});

test("decideOrchestratorExitCode: loginRequired が最優先で 15 を返し、exitedOnQuota が 11、failed が 1、正常が 0", () => {
  // ログイン切れは最優先（exitedOnQuota や過去の失敗があっても 15）
  assert.equal(
    decideOrchestratorExitCode({ loginRequired: true, exitedOnQuota: true, failedCount: 2 }),
    EXIT_LOGIN_REQUIRED,
  );
  assert.equal(
    decideOrchestratorExitCode({ loginRequired: true, exitedOnQuota: false, failedCount: 0 }),
    EXIT_LOGIN_REQUIRED,
  );

  // 利用枠終了は失敗より優先（11）
  assert.equal(
    decideOrchestratorExitCode({ loginRequired: false, exitedOnQuota: true, failedCount: 3 }),
    EXIT_QUOTA,
  );
  assert.equal(
    decideOrchestratorExitCode({ loginRequired: false, exitedOnQuota: true, failedCount: 0 }),
    EXIT_QUOTA,
  );

  // 失敗がある場合は 1
  assert.equal(
    decideOrchestratorExitCode({ loginRequired: false, exitedOnQuota: false, failedCount: 1 }),
    1,
  );

  // 全て正常終了時は 0
  assert.equal(
    decideOrchestratorExitCode({ loginRequired: false, exitedOnQuota: false, failedCount: 0 }),
    0,
  );

  // 生成待ちタイムアウト終了時は 16 (EXIT_WAITING_TIMEOUT)
  assert.equal(
    decideOrchestratorExitCode({ loginRequired: false, exitedOnQuota: false, exitedOnWaitingTimeout: true, failedCount: 0 }),
    EXIT_WAITING_TIMEOUT,
  );
  // ログイン切れは生成待ちタイムアウトより優先 (15)
  assert.equal(
    decideOrchestratorExitCode({ loginRequired: true, exitedOnQuota: false, exitedOnWaitingTimeout: true, failedCount: 0 }),
    EXIT_LOGIN_REQUIRED,
  );
});

test("decideIdleAction: maxWaitingMinutes 超過かつ収穫可能ジョブなしで終了 (exit_waiting)", () => {
  const jobs = [
    makeJob({ id: "paper1.pdf", status: "waiting", harvestable: false }),
    makeJob({ id: "paper2.pdf", status: "waiting", harvestable: false }),
    makeJob({ id: "done.pdf", status: "done", harvestable: false }),
  ];

  const now = Date.now();
  const waitingSince = now - 65 * 60_000; // 65分前

  const result = decideIdleAction(
    { kind: "idle", sleepMs: 60_000 },
    {
      generationBlocked: false,
      jobs,
      exitOnQuota: false,
      maxWaitingMinutes: 60,
      waitingSince,
      now,
      getWaitingStage: (id) => (id === "paper1.pdf" ? "nlm-video" : "nlm-slides"),
    },
  );

  assert.deepEqual(result, {
    action: "exit_waiting",
    waitingPapers: [
      { filename: "paper1.pdf", stage: "nlm-video" },
      { filename: "paper2.pdf", stage: "nlm-slides" },
    ],
    elapsedMinutes: 65,
  });
});

test("decideIdleAction: maxWaitingMinutes 未満なら sleep を返す", () => {
  const jobs = [
    makeJob({ id: "paper1.pdf", status: "waiting", harvestable: false }),
  ];

  const now = Date.now();
  const waitingSince = now - 30 * 60_000; // 30分前（しきい値 60 分未満）

  const result = decideIdleAction(
    { kind: "idle", sleepMs: 45_000 },
    {
      generationBlocked: false,
      jobs,
      exitOnQuota: false,
      maxWaitingMinutes: 60,
      waitingSince,
      now,
    },
  );

  assert.deepEqual(result, {
    action: "sleep",
    sleepMs: 45_000,
    generationBlocked: false,
  });
});

test("decideIdleAction: maxWaitingMinutes 超過でも収穫可能作業が残っていれば exit_waiting せず sleep", () => {
  const jobs = [
    makeJob({ id: "waiting.pdf", status: "waiting", harvestable: false }),
    makeJob({ id: "harvest-ready.pdf", status: "ready", harvestable: true }),
  ];

  const now = Date.now();
  const waitingSince = now - 70 * 60_000;

  const result = decideIdleAction(
    { kind: "idle", sleepMs: 10_000 },
    {
      generationBlocked: false,
      jobs,
      exitOnQuota: false,
      maxWaitingMinutes: 60,
      waitingSince,
      now,
    },
  );

  assert.deepEqual(result, {
    action: "sleep",
    sleepMs: 10_000,
    generationBlocked: false,
  });
});

test("decideIdleAction: maxWaitingMinutes が 0（無効）のときは時間超過でも sleep", () => {
  const jobs = [
    makeJob({ id: "waiting.pdf", status: "waiting", harvestable: false }),
  ];

  const now = Date.now();
  const waitingSince = now - 120 * 60_000;

  const result = decideIdleAction(
    { kind: "idle", sleepMs: 30_000 },
    {
      generationBlocked: false,
      jobs,
      exitOnQuota: false,
      maxWaitingMinutes: 0,
      waitingSince,
      now,
    },
  );

  assert.deepEqual(result, {
    action: "sleep",
    sleepMs: 30_000,
    generationBlocked: false,
  });
});

test("formatExitOnWaitingMessage: 待機中の論文と段階、経過時間を出力する", () => {
  const msg = formatExitOnWaitingMessage(
    [
      { filename: "2607.07405v2.pdf", stage: "nlm-video" },
      { filename: "2607.27250v1.pdf", stage: "nlm-video" },
    ],
    60,
  );
  assert.ok(msg.includes("60 分"), "経過分を含む");
  assert.ok(msg.includes("2607.07405v2.pdf (nlm-video)"), "論文名と段階を含む");
  assert.ok(msg.includes("2607.27250v1.pdf (nlm-video)"), "論文名と段階を含む");
});

