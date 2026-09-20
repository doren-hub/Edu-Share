import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.ts";
import { log, warn } from "./log.ts";

export type BrowserSession = {
  context: BrowserContext;
  page: Page;
};

let chromeDownloadsPath = "";

export function getChromeDownloadsPath(): string {
  return chromeDownloadsPath;
}

export function isTargetClosedError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /has been closed|Target closed|browser has been closed|Connection closed|ページが閉じられました/i.test(m);
}

export async function pageAlive(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    await Promise.race([
      page.evaluate("true"),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("pageAlive timeout")), 5_000);
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function recoverStuckPage(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  if (await pageAlive(page)) return true;
  warn("ページが応答しないため about:blank に戻します");
  await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  return pageAlive(page);
}

export async function assertPageAlive(page: Page): Promise<void> {
  if (await recoverStuckPage(page)) return;
  throw new Error("ブラウザが閉じられています");
}

function markChromeExitedCleanly(userDataDir: string): void {
  const prefsPath = join(userDataDir, "Default", "Preferences");
  if (!existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as {
      profile?: { exit_type?: string; exited_cleanly?: boolean };
    };
    prefs.profile = { ...prefs.profile, exit_type: "Normal", exited_cleanly: true };
    writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (e) {
    warn(`Chrome の終了フラグを直せません: ${e instanceof Error ? e.message : e}`);
  }
}

function clearStaleChromeProfileLocks(userDataDir: string): void {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const p = join(userDataDir, name);
    if (!existsSync(p)) continue;
    try {
      if (!lstatSync(p).isSymbolicLink()) continue;
      const target = readlinkSync(p);
      const m = /-(\d+)$/.exec(target);
      const pid = m ? Number(m[1]) : NaN;
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0);
          continue;
        } catch {
          /* プロセス無し = 古いロック */
        }
      }
      unlinkSync(p);
      log(`古い Chrome ロックを削除: ${name}`);
    } catch {
      /* 起動時の掃除。失敗しても続行 */
    }
  }
}

export async function launchBrowser(cfg: AppConfig): Promise<BrowserSession> {
  mkdirSync(cfg.chromeUserDataDir, { recursive: true });
  const downloadsPath = join(cfg.chromeUserDataDir, "playwright-downloads");
  mkdirSync(downloadsPath, { recursive: true });
  chromeDownloadsPath = downloadsPath;
  clearStaleChromeProfileLocks(cfg.chromeUserDataDir);
  markChromeExitedCleanly(cfg.chromeUserDataDir);
  const args: string[] = [
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--disable-infobars",
  ];
  if (cfg.exportExtensionPath) {
    // disable-extensions-except は Chrome の PDF ビューアまで消すので使わない
    args.push(`--load-extension=${cfg.exportExtensionPath}`);
    log(`Export 拡張を読み込み: ${cfg.exportExtensionPath}`);
  }
  const launchOpts = {
    headless: !cfg.headed,
    viewport: { width: 1400, height: 900 } as const,
    acceptDownloads: true,
    downloadsPath,
    args,
    ignoreDefaultArgs: ["--enable-automation", "--enable-features=Translate", "--no-sandbox"],
  };
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(cfg.chromeUserDataDir, {
      ...launchOpts,
      channel: "chrome",
    });
  } catch (e) {
    log(
      `Google Chrome での起動に失敗したため、バンドル Chromium を使います（${e instanceof Error ? e.message : e}）`,
    );
    context = await chromium.launchPersistentContext(cfg.chromeUserDataDir, launchOpts);
  }
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);
  if (context.pages().length < 2) {
    const keeper = await context.newPage();
    await keeper.goto("about:blank").catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
  }
  return { context, page };
}

export async function closeBrowser(session: BrowserSession): Promise<void> {
  await session.context.close().catch(() => undefined);
}
