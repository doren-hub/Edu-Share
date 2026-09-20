import { test } from "node:test";
import assert from "node:assert/strict";
import { pickNextJob, type SchedJob } from "./schedule.ts";

function job(partial: Partial<SchedJob> & Pick<SchedJob, "id">): SchedJob {
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

test("pickNextJob: 準備できた論文は変更日が古い順", () => {
  const jobs = [
    job({ id: "new.pdf", mtime: 20, status: "ready" }),
    job({ id: "old.pdf", mtime: 10, status: "ready" }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "old.pdf" });
});

test("pickNextJob: MP4 待ちで収穫が無い論文より、未完了の ready を先に回す", () => {
  const jobs = [
    job({
      id: "mp4-wait.pdf",
      mtime: 1,
      status: "waiting",
      nextCheckAt: 80,
      kickoffBegun: true,
      kickoffSettled: true,
      harvestable: false,
    }),
    job({
      id: "unsettled.pdf",
      mtime: 50,
      status: "ready",
      kickoffBegun: true,
      kickoffSettled: false,
    }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "unsettled.pdf" });
});

test("pickNextJob: 4種開始済みの生成待ちより、未着手の ready を先に回す", () => {
  const jobs = [
    job({ id: "ready.pdf", mtime: 1, status: "ready" }),
    job({
      id: "wait.pdf",
      mtime: 50,
      status: "waiting",
      nextCheckAt: 80,
      kickoffBegun: true,
      kickoffSettled: true,
    }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "ready.pdf" });
});

test("pickNextJob: 4種開始済みで待ち中なら次の ready を回す", () => {
  const jobs = [
    job({
      id: "wait.pdf",
      mtime: 1,
      status: "waiting",
      nextCheckAt: 500,
      kickoffBegun: true,
      kickoffSettled: true,
    }),
    job({ id: "next.pdf", mtime: 2, status: "ready" }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "next.pdf" });
});

test("pickNextJob: ready が無く待ち中なら idle", () => {
  const jobs = [job({ id: "wait.pdf", status: "waiting", nextCheckAt: 250 })];
  const r = pickNextJob(jobs, 100);
  assert.equal(r.kind, "idle");
  if (r.kind === "idle") assert.equal(r.sleepMs, 1_000);
});

test("pickNextJob: 完了・スキップ・失敗だけなら done", () => {
  const jobs = [
    job({ id: "a.pdf", status: "done" }),
    job({ id: "b.pdf", status: "skipped" }),
    job({ id: "c.pdf", status: "failed" }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "done" });
});

test("pickNextJob: 3回失敗後の waiting は再確認時刻まで idle", () => {
  const jobs = [job({ id: "retry.pdf", status: "waiting", nextCheckAt: 250 })];
  const r = pickNextJob(jobs, 100);
  assert.equal(r.kind, "idle");
  if (r.kind === "idle") assert.equal(r.sleepMs, 1_000);
});

test("pickNextJob: 失敗した論文より、まだ失敗していない ready を先に回す", () => {
  const jobs = [
    job({ id: "failed-old.pdf", mtime: 1, attempts: 1 }),
    job({ id: "fresh.pdf", mtime: 50, attempts: 0 }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "fresh.pdf" });
});

test("pickNextJob: inbox の未完了を MP4 補修より先に回す", () => {
  const jobs = [
    job({ id: "repair.pdf", mtime: 1, source: "repair" }),
    job({ id: "inbox.pdf", mtime: 50, source: "inbox" }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "inbox.pdf" });
});

test("pickNextJob: inbox が失敗中なら未失敗の補修を先に回す", () => {
  const jobs = [
    job({ id: "inbox.pdf", mtime: 1, source: "inbox", attempts: 1 }),
    job({ id: "repair.pdf", mtime: 50, source: "repair", attempts: 0 }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "repair.pdf" });
});

test("pickNextJob: 4種が揃うまでは次の論文の生成に進まない", () => {
  const jobs = [
    job({
      id: "partial.pdf",
      mtime: 1,
      kickoffBegun: true,
      kickoffSettled: false,
    }),
    job({ id: "next.pdf", mtime: 2, status: "ready" }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "partial.pdf" });
});

test("pickNextJob: 4種未完了のキックオフは失敗回数が多くても同じ論文を先に回す", () => {
  const jobs = [
    job({
      id: "partial.pdf",
      mtime: 1,
      attempts: 2,
      kickoffBegun: true,
      kickoffSettled: false,
    }),
    job({ id: "fresh.pdf", mtime: 50, attempts: 0 }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "partial.pdf" });
});

test("pickNextJob: 4種未完了が複数なら古い論文だけ続ける", () => {
  const jobs = [
    job({
      id: "newer.pdf",
      mtime: 20,
      kickoffBegun: true,
      kickoffSettled: false,
    }),
    job({
      id: "older.pdf",
      mtime: 10,
      kickoffBegun: true,
      kickoffSettled: false,
    }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "older.pdf" });
});

test("pickNextJob: 4種未完了が待ち中なら次の論文へ進まず idle", () => {
  const jobs = [
    job({
      id: "partial.pdf",
      mtime: 1,
      status: "waiting",
      nextCheckAt: 500,
      kickoffBegun: true,
      kickoffSettled: false,
    }),
    job({ id: "next.pdf", mtime: 2, status: "ready" }),
  ];
  const r = pickNextJob(jobs, 100);
  assert.equal(r.kind, "idle");
  if (r.kind === "idle") assert.equal(r.sleepMs, 1_000);
});

test("pickNextJob: 4種未完了でも Files 貼り付け補修は先に回す", () => {
  const jobs = [
    job({
      id: "partial.pdf",
      mtime: 1,
      kickoffBegun: true,
      kickoffSettled: false,
    }),
    job({
      id: "paste.pdf",
      mtime: 50,
      source: "repair",
      harvestable: true,
      kickoffSettled: true,
    }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "paste.pdf" });
});

test("pickNextJob: 4種済みの収穫（verify 等）を未着手の生成より先に回す", () => {
  const jobs = [
    job({ id: "new.pdf", mtime: 1, harvestable: true, kickoffSettled: false }),
    job({
      id: "verify.pdf",
      mtime: 50,
      harvestable: true,
      kickoffBegun: true,
      kickoffSettled: true,
    }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100), { kind: "run", id: "verify.pdf" });
});
test("pickNextJob: 利用量待ちなら生成ロックを外して収穫できる論文を回す", () => {
  const jobs = [
    job({
      id: "generating.pdf",
      mtime: 1,
      kickoffBegun: true,
      kickoffSettled: false,
      harvestable: false,
    }),
    job({
      id: "harvest.pdf",
      mtime: 50,
      harvestable: true,
    }),
  ];
  assert.deepEqual(pickNextJob(jobs, 100, { generationBlocked: true }), {
    kind: "run",
    id: "harvest.pdf",
  });
});

test("pickNextJob: 利用量待ちで収穫できる論文が無ければ idle", () => {
  const jobs = [
    job({
      id: "generating.pdf",
      kickoffBegun: true,
      kickoffSettled: false,
      harvestable: false,
    }),
  ];
  const r = pickNextJob(jobs, 100, { generationBlocked: true });
  assert.equal(r.kind, "idle");
  if (r.kind === "idle") assert.equal(r.sleepMs, 60_000);
});
