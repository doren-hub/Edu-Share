import { createInterface } from "node:readline";
import type { Page } from "playwright";
import { log } from "./log.ts";

/** 画面付き Chrome のときだけ人の操作（Enter）を待つ。launchBrowser が更新する。 */
let interactiveUi = true;

export function setInteractiveUi(enabled: boolean): void {
  interactiveUi = enabled;
}

export function isInteractiveUi(): boolean {
  return interactiveUi;
}

/** ヘッドレス中にログイン画面へ来た。呼び出し側が画面付きへ切り替える */
export class NeedVisibleChromeError extends Error {
  readonly context: string;
  readonly url: string;
  readonly reason?: string;
  constructor(context: string, url: string, reason?: string) {
    super(`${context}: ログインまたは追加確認が必要です${reason ? `（${reason}）` : ""}`);
    this.name = "NeedVisibleChromeError";
    this.context = context;
    this.url = url;
    this.reason = reason;
  }
}

export type HumanPauseMode = "enter" | "poll" | "promote";

export function humanPauseMode(opts?: {
  headed?: boolean;
  stdinIsTty?: boolean;
}): HumanPauseMode {
  const headed = opts?.headed ?? interactiveUi;
  if (!headed) return "promote";
  const tty = opts?.stdinIsTty ?? Boolean(process.stdin.isTTY);
  return tty ? "enter" : "poll";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForEnter(message: string): Promise<void> {
  log(message);
  if (humanPauseMode() !== "enter") {
    log("非対話のため Enter 待ちはせず、画面の完了を待ちます");
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question("準備ができたら Enter: ", () => {
      rl.close();
      resolve();
    });
  });
}

export function pageLooksLikeGoogleLogin(url: string, body: string): boolean {
  if (/accounts\.google\.com|signin\.google/i.test(url)) return true;
  return /Google でログイン|Sign in with Google|アカウントを選択してください|ログアウト済み|別のアカウントを使用/i.test(
    body,
  );
}

export function pageLooksLikeLoginWall(url: string, body: string): boolean {
  if (pageLooksLikeGoogleLogin(url, body)) return true;
  if (/\/auth\/login(?:\/|\?|$)/i.test(url)) return true;
  if (/ログインが必要/.test(body)) return true;
  if (/scispace\.com/i.test(url) && /log in to|sign in to|ログインして|ログインが必要/i.test(body)) return true;
  return false;
}

export async function looksLikeGoogleLogin(page: Page): Promise<boolean> {
  let url = "";
  try {
    url = page.url();
  } catch {
    return false;
  }
  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return pageLooksLikeLoginWall(url, body);
}

export function pageLooksLikeBotChallenge(url: string, title: string, body: string): boolean {
  if (
    /Just a moment\.\.\.|Attention Required! \| Cloudflare|Security Check|Verify you are human|Bot Verification|Cloudflare/i.test(
      title,
    )
  ) {
    return true;
  }
  if (/challenges\.cloudflare\.com|cf-turnstile|cf-challenge/i.test(url)) return true;
  return (
    /Checking your browser before accessing|Verify you are human|Enable JavaScript and cookies to continue|Ray ID:|Performance & security by Cloudflare|Access denied|unusual traffic|ロボットではありません/i.test(
      body,
    ) || /captcha|recaptcha/i.test(body)
  );
}

export async function looksLikeBotChallenge(page: Page): Promise<boolean> {
  let url = "";
  let title = "";
  try {
    url = page.url();
    title = await page.title().catch(() => "");
  } catch {
    return false;
  }
  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  if (pageLooksLikeBotChallenge(url, title, body)) return true;
  const cfIframe = await page
    .locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="cloudflare"], .cf-turnstile, #cf-turnstile')
    .first()
    .isVisible({ timeout: 0 })
    .catch(() => false);
  return cfIframe;
}

export async function looksLikeCaptcha(page: Page): Promise<boolean> {
  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return /captcha|recaptcha|unusual traffic|ロボットではありません/i.test(body);
}

export async function waitUntilUnblocked(page: Page, context: string): Promise<void> {
  const start = Date.now();
  const limit = 15 * 60_000;
  let lastBeat = 0;
  while (Date.now() - start < limit) {
    if (page.isClosed()) throw new Error(`${context}: 待ち中にブラウザが閉じられました`);
    if (
      !(await looksLikeGoogleLogin(page)) &&
      !(await looksLikeCaptcha(page)) &&
      !(await looksLikeBotChallenge(page))
    ) {
      return;
    }
    if (Date.now() - lastBeat >= 30_000) {
      lastBeat = Date.now();
      const left = Math.max(0, Math.round((limit - (Date.now() - start)) / 1000));
      log(`${context}: ログイン待ち（残り約 ${left}s）`);
    }
    await sleep(2000);
  }
  throw new Error(`${context}: ログイン待ちがタイムアウトしました`);
}

export async function pauseIfBlocked(page: Page, context: string): Promise<void> {
  if (
    !(await looksLikeCaptcha(page)) &&
    !(await looksLikeGoogleLogin(page)) &&
    !(await looksLikeBotChallenge(page))
  ) {
    return;
  }
  const mode = humanPauseMode();
  if (mode === "promote") {
    let url = "";
    try {
      url = page.url();
    } catch {
      /* 閉じたタブ */
    }
    throw new NeedVisibleChromeError(context, url, "ボット判定またはログイン待ち");
  }
  if (mode === "enter") {
    await waitForEnter(
      `${context}: ログインまたは追加確認が必要です。ブラウザで済ませてから Enter を押してください。`,
    );
  } else {
    log(`${context}: ログイン中は画面を触りません。このウィンドウでアカウントを選んでログインしてください`);
  }
  await waitUntilUnblocked(page, context);
}
