import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.ts";
import { setInteractiveUi } from "./human.ts";
import { log, warn } from "./log.ts";

export type BrowserSession = {
  context: BrowserContext;
  page: Page;
};

let chromeDownloadsPath = "";

export const CHROME_RELAUNCH_GAP_MS = 2_500;

export function getChromeDownloadsPath(): string {
  return chromeDownloadsPath;
}

export function isTargetClosedMessage(m: string): boolean {
  return /has been closed|Target closed|browser has been closed|Connection closed|ページが閉じられました|ブラウザが閉じられています/i.test(
    m,
  );
}

export function isTargetClosedError(e: unknown): boolean {
  return isTargetClosedMessage(e instanceof Error ? e.message : String(e));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function prepareChromeProfile(userDataDir: string, downloadsPath: string): void {
  const prefsPath = join(userDataDir, "Default", "Preferences");
  mkdirSync(join(userDataDir, "Default"), { recursive: true });
  let prefs: Record<string, unknown> = {};
  if (existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as Record<string, unknown>;
    } catch {
      warn("Chrome の Preferences を読めないので保存先は書き換えません");
      return;
    }
  }
  const profile =
    prefs.profile && typeof prefs.profile === "object" ? (prefs.profile as Record<string, unknown>) : {};
  profile.exit_type = "Normal";
  profile.exited_cleanly = true;
  prefs.profile = profile;
  const download =
    prefs.download && typeof prefs.download === "object" ? (prefs.download as Record<string, unknown>) : {};
  download.default_directory = downloadsPath;
  download.prompt_for_download = false;
  prefs.download = download;
  const savefile =
    prefs.savefile && typeof prefs.savefile === "object" ? (prefs.savefile as Record<string, unknown>) : {};
  savefile.default_directory = downloadsPath;
  prefs.savefile = savefile;
  try {
    writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (e) {
    warn(`Chrome の保存先を直せません: ${e instanceof Error ? e.message : e}`);
  }
}

/** Playwright の allowAndName だと GUID 中間ファイルになり、タブ切断で打ち切られる */
async function useChromeOwnDownloads(context: BrowserContext, downloadsPath: string, page: Page): Promise<void> {
  const session = await context.newCDPSession(page);
  await session.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadsPath,
    eventsEnabled: false,
  });
  await session
    .send("Network.enable", {
      maxResourceBufferSize: 256 * 1024 * 1024,
      maxPostDataSize: 0,
    })
    .catch(() => undefined);
  log(`Chrome 保存先: ${downloadsPath}（ブラウザ自身に書かせます）`);
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

function clearStaleIncompleteDownloads(downloadsPath: string): void {
  let n = 0;
  try {
    for (const name of readdirSync(downloadsPath)) {
      if (!name.endsWith(".crdownload")) continue;
      try {
        unlinkSync(join(downloadsPath, name));
        n += 1;
      } catch {
        /* 起動時の掃除。失敗しても続行 */
      }
    }
  } catch {
    return;
  }
  if (n) log(`未完了ダウンロード ${n} 件を削除しました`);
}

export function chromeLaunchArgs(cfg: Pick<AppConfig, "headed" | "exportExtensionPath">): string[] {
  const args: string[] = [
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--disable-infobars",
    "--disable-blink-features=AutomationControlled",
    "--exclude-switches=enable-automation",
  ];
  if (!cfg.headed) {
    // channel: "chrome" の旧ヘッドレスでは拡張が動かないため new を明示する
    args.push("--headless=new");
  }
  if (cfg.exportExtensionPath) {
    args.push(`--load-extension=${cfg.exportExtensionPath}`);
  }
  return args;
}

export async function launchBrowser(cfg: AppConfig): Promise<BrowserSession> {
  setInteractiveUi(cfg.headed);
  mkdirSync(cfg.chromeUserDataDir, { recursive: true });
  const downloadsPath = join(cfg.chromeUserDataDir, "playwright-downloads");
  mkdirSync(downloadsPath, { recursive: true });
  chromeDownloadsPath = downloadsPath;
  clearStaleIncompleteDownloads(downloadsPath);
  clearStaleChromeProfileLocks(cfg.chromeUserDataDir);
  prepareChromeProfile(cfg.chromeUserDataDir, downloadsPath);
  const args = chromeLaunchArgs(cfg);
  if (cfg.exportExtensionPath) {
    log(`Export 拡張を読み込み: ${cfg.exportExtensionPath}`);
  }
  log(cfg.headed ? "Chrome を画面付きで起動します" : "Chrome をヘッドレスで起動します（ウィンドウは開きません）");
  const launchOpts = {
    headless: !cfg.headed,
    viewport: { width: 1400, height: 900 } as const,
    acceptDownloads: false, // Playwright が横取りすると .crdownload が止まり Chrome が落ちる
    args,
    ignoreDefaultArgs: [
      "--enable-automation",
      "--enable-features=Translate",
      "--no-sandbox",
      "--use-mock-keychain",
      "--password-store=basic",
      "--disable-sync",
      "--metrics-recording-only",
    ],
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
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const keeper = context.pages()[0] ?? (await context.newPage());
  keeper.setDefaultTimeout(30_000);
  await keeper.goto("about:blank").catch(() => undefined);
  await useChromeOwnDownloads(context, downloadsPath, keeper).catch((e) => {
    warn(`Chrome の保存先を切り替えできません: ${e instanceof Error ? e.message : e}`);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);
  return { context, page };
}

export async function closeBrowser(session: BrowserSession): Promise<void> {
  await Promise.race([
    session.context.close().catch(() => undefined),
    sleep(12_000),
  ]);
  // Google セッションをプロファイルに書き終わるまで待つ
  await sleep(2_000);
}

export async function relaunchBrowser(session: BrowserSession, cfg: AppConfig): Promise<BrowserSession> {
  await closeBrowser(session);
  await sleep(CHROME_RELAUNCH_GAP_MS);
  return launchBrowser(cfg);
}
