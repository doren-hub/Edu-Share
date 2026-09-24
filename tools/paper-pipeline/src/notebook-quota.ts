import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log, warn } from "./log.ts";

export const DEFAULT_SHORT_STOP_PERCENT = 85;
export const DEFAULT_WEEKLY_STOP_PERCENT = 100;
export const EXIT_QUOTA = 11;

const FETCH_TIMEOUT_MS = 1_500;
const SHORT_POLL_MS = 60_000;
const WEEKLY_POLL_MS = 15 * 60_000;
const MIN_SLEEP_MS = 5_000;

export type NotebookQuota = {
  shortUsed: number | null;
  shortRemaining: number | null;
  shortResetAt: number | null;
  shortResetLabel: string;
  weeklyUsed: number | null;
  weeklyRemaining: number | null;
  weeklyResetAt: number | null;
  weeklyResetLabel: string;
  source: string;
};

export type NotebookQuotaPause = {
  reason: "short" | "weekly";
  until: number | null;
  untilLabel: string;
  used: number;
  /** この％を超えたら止める。短期は指定値、週枠は週の上限 */
  stopPercent: number;
};

export class NotebookQuotaPauseError extends Error {
  constructor(
    readonly pause: NotebookQuotaPause,
    readonly quota: NotebookQuota,
  ) {
    super(formatQuotaPause(pause, quota));
    this.name = "NotebookQuotaPauseError";
  }
}

export type NotebookQuotaConfig = {
  ignoreNotebookQuota: boolean;
  notebookQuotaUrls: readonly string[];
  notebookQuotaFiles: readonly string[];
  notebookShortStopPercent: number;
  notebookWeeklyStopPercent: number;
};

type FetchJson = (url: string) => Promise<unknown | null>;
type ReadFile = (path: string) => string | null;
type Sleeper = (ms: number) => Promise<void>;

export function defaultNotebookQuotaUrls(): string[] {
  const extra = (process.env.TASKDESK_USAGE_URL ?? "").trim();
  const taskdesk = stripSlash((process.env.TASKDESK_URL ?? "http://127.0.0.1:8765").trim());
  const board = stripSlash((process.env.AI_USAGE_BOARD_URL ?? "http://127.0.0.1:8766").trim());
  return unique([
    extra,
    `${board}/usage-latest.json`,
    extra && looksLikeJsonPath(extra) ? "" : `${taskdesk}/usage-latest.json`,
    `${taskdesk}/api/usage`,
  ]);
}

export function defaultNotebookQuotaFiles(): string[] {
  const dir = (process.env.AI_DISPATCH_DIR ?? join(homedir(), ".local/share/ai-dispatch")).trim();
  const extra = (process.env.TASKDESK_USAGE_FILE ?? "").trim();
  return unique([
    extra,
    join(dir, "usage-latest.json"),
    join(dir, "notebooklm-cache.json"),
  ]);
}

export function parseResetAtJst(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}+09:00`;
    const n = Date.parse(iso);
    return Number.isFinite(n) ? n : null;
  }
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

export function usedFromMetric(metric: {
  used_percent?: unknown;
  remaining_percent?: unknown;
}): number | null {
  if (isFiniteNumber(metric.used_percent)) return metric.used_percent;
  if (isFiniteNumber(metric.remaining_percent)) return 100 - metric.remaining_percent;
  return null;
}

export function remainingFromMetric(metric: {
  used_percent?: unknown;
  remaining_percent?: unknown;
}): number | null {
  if (isFiniteNumber(metric.remaining_percent)) return metric.remaining_percent;
  if (isFiniteNumber(metric.used_percent)) return 100 - metric.used_percent;
  return null;
}

export function extractNotebookQuota(payload: unknown, source: string): NotebookQuota | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  if (isFiniteNumber(rec.short_term_used_percent) || isFiniteNumber(rec.used_percent)) {
    const shortUsed = isFiniteNumber(rec.short_term_used_percent)
      ? rec.short_term_used_percent
      : usedFromMetric({ remaining_percent: rec.short_term_remaining_percent });
    const weeklyUsed = isFiniteNumber(rec.used_percent)
      ? rec.used_percent
      : usedFromMetric({ remaining_percent: rec.remaining_percent });
    if (shortUsed == null && weeklyUsed == null) return null;
    return {
      shortUsed,
      shortRemaining: remainingFromMetric({
        used_percent: rec.short_term_used_percent,
        remaining_percent: rec.short_term_remaining_percent,
      }),
      shortResetAt: parseResetAtJst(rec.short_term_reset_at),
      shortResetLabel: typeof rec.short_term_reset_at === "string" ? rec.short_term_reset_at : "",
      weeklyUsed,
      weeklyRemaining: remainingFromMetric({
        used_percent: rec.used_percent,
        remaining_percent: rec.remaining_percent,
      }),
      weeklyResetAt: parseResetAtJst(rec.reset_at),
      weeklyResetLabel: typeof rec.reset_at === "string" ? rec.reset_at : "",
      source,
    };
  }
  const metrics = collectMetrics(rec);
  const short = metrics.find((m) => isNotebookShortLabel(String(m.label ?? "")));
  const weekly = metrics.find((m) => isNotebookWeeklyLabel(String(m.label ?? "")));
  if (!short && !weekly) return null;
  const shortReset = short ? String(short.reset_at ?? "") : "";
  const weeklyReset = weekly ? String(weekly.reset_at ?? "") : "";
  return {
    shortUsed: short ? usedFromMetric(short) : null,
    shortRemaining: short ? remainingFromMetric(short) : null,
    shortResetAt: parseResetAtJst(shortReset),
    shortResetLabel: shortReset,
    weeklyUsed: weekly ? usedFromMetric(weekly) : null,
    weeklyRemaining: weekly ? remainingFromMetric(weekly) : null,
    weeklyResetAt: parseResetAtJst(weeklyReset),
    weeklyResetLabel: weeklyReset,
    source,
  };
}

export function notebookGenerationPause(
  quota: NotebookQuota | null,
  now = Date.now(),
  shortStop = DEFAULT_SHORT_STOP_PERCENT,
  weeklyStop = DEFAULT_WEEKLY_STOP_PERCENT,
): NotebookQuotaPause | null {
  if (!quota) return null;
  if (quota.weeklyUsed != null && quota.weeklyUsed >= weeklyStop) {
    if (quota.weeklyResetAt != null && quota.weeklyResetAt <= now) return null;
    return {
      reason: "weekly",
      until: quota.weeklyResetAt,
      untilLabel: quota.weeklyResetLabel,
      used: quota.weeklyUsed,
      stopPercent: weeklyStop,
    };
  }
  if (quota.shortUsed != null && quota.shortUsed > shortStop) {
    if (quota.shortResetAt != null && quota.shortResetAt <= now) return null;
    return {
      reason: "short",
      until: quota.shortResetAt,
      untilLabel: quota.shortResetLabel,
      used: quota.shortUsed,
      stopPercent: shortStop,
    };
  }
  return null;
}

export function formatQuotaPause(pause: NotebookQuotaPause, quota?: NotebookQuota): string {
  const until = pause.untilLabel || (pause.until ? formatJst(pause.until) : "再確認まで");
  if (pause.reason === "weekly") {
    return `Notebook 週枠が ${fmtPct(pause.used)}% のため ${until} まで生成を止めます${sourceSuffix(quota)}`;
  }
  return `Notebook 短期枠が ${fmtPct(pause.used)}%（しきい値 ${fmtPct(pause.stopPercent)}% 超）のため ${until} まで生成を止めます${sourceSuffix(quota)}`;
}

export async function loadNotebookQuota(
  cfg: NotebookQuotaConfig,
  deps: { fetchJson?: FetchJson; readFile?: ReadFile } = {},
): Promise<NotebookQuota | null> {
  const fetchJson = deps.fetchJson ?? fetchJsonUrl;
  const readFile = deps.readFile ?? readTextFile;
  const remote = await Promise.all(
    cfg.notebookQuotaUrls.map(async (url) => ({ url, payload: await fetchJson(url) })),
  );
  for (const { url, payload } of remote) {
    const quota = extractNotebookQuota(payload, url);
    if (quota) return quota;
  }
  for (const path of cfg.notebookQuotaFiles) {
    const text = readFile(path);
    if (!text) continue;
    try {
      const quota = extractNotebookQuota(JSON.parse(text), path);
      if (quota) return quota;
    } catch {
      // 壊れた JSON は次へ
    }
  }
  return null;
}

export async function currentNotebookQuotaPause(
  cfg: NotebookQuotaConfig,
  deps: { fetchJson?: FetchJson; readFile?: ReadFile; now?: () => number } = {},
): Promise<NotebookQuotaPause | null> {
  if (cfg.ignoreNotebookQuota) return null;
  const quota = await loadNotebookQuota(cfg, deps);
  return notebookGenerationPause(
    quota,
    (deps.now ?? Date.now)(),
    cfg.notebookShortStopPercent,
    cfg.notebookWeeklyStopPercent,
  );
}

export async function waitUntilNotebookQuotaAllows(
  cfg: NotebookQuotaConfig,
  deps: {
    fetchJson?: FetchJson;
    readFile?: ReadFile;
    sleep?: Sleeper;
    now?: () => number;
  } = {},
): Promise<void> {
  if (cfg.ignoreNotebookQuota) return;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let warnedMissing = false;
  for (;;) {
    const quota = await loadNotebookQuota(cfg, deps);
    const pause = notebookGenerationPause(
      quota,
      now(),
      cfg.notebookShortStopPercent,
      cfg.notebookWeeklyStopPercent,
    );
    if (!pause) {
      if (!quota && !warnedMissing) {
        warn("Notebook の利用量が taskdesk / 利用量ボードから読めません。生成は続けます");
        warnedMissing = true;
      }
      return;
    }
    const remaining = pause.until != null ? pause.until - now() : SHORT_POLL_MS;
    const cap = pause.reason === "weekly" ? WEEKLY_POLL_MS : SHORT_POLL_MS;
    const waitMs = Math.min(Math.max(remaining, MIN_SLEEP_MS), cap);
    log(formatQuotaPause(pause, quota ?? undefined));
    log(`Notebook 利用量の再確認まで約 ${Math.ceil(waitMs / 1000)}s 待ちます`);
    await sleep(waitMs);
  }
}

function collectMetrics(rec: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const providers = Array.isArray(rec.providers) ? rec.providers : [rec];
  for (const provider of providers) {
    if (!provider || typeof provider !== "object") continue;
    const p = provider as Record<string, unknown>;
    for (const key of ["metrics", "windows"] as const) {
      const list = p[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item && typeof item === "object") out.push(item as Record<string, unknown>);
      }
    }
  }
  return out;
}

function isNotebookShortLabel(label: string): boolean {
  return /Gemini Notebook/.test(label) && /短期/.test(label);
}

function isNotebookWeeklyLabel(label: string): boolean {
  return /Gemini Notebook/.test(label) && /週/.test(label);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

function looksLikeJsonPath(u: string): boolean {
  return /\.json(\?|$)/i.test(u) || /\/api\//.test(u);
}

function unique(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const v = x.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function fmtPct(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function formatJst(ms: number): string {
  const d = new Date(ms);
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return p.replace("T", " ");
}

function sourceSuffix(quota?: NotebookQuota): string {
  return quota?.source ? `（${quota.source}）` : "";
}

async function fetchJsonUrl(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("text/html")) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
