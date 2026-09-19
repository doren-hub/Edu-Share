import { createInterface } from "node:readline";
import type { Page } from "playwright";
import { log } from "./log.ts";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForEnter(message: string): Promise<void> {
  log(message);
  if (!process.stdin.isTTY) {
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

export async function looksLikeGoogleLogin(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/accounts\.google\.com|signin\.google/i.test(url)) return true;
  } catch {
    return false;
  }
  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return /Google でログイン|Sign in with Google/i.test(body);
}

export async function looksLikeCaptcha(page: Page): Promise<boolean> {
  const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return /captcha|recaptcha|unusual traffic|ロボットではありません/i.test(body);
}

export async function pauseIfBlocked(page: Page, context: string): Promise<void> {
  if (!(await looksLikeCaptcha(page)) && !(await looksLikeGoogleLogin(page))) return;
  if (process.stdin.isTTY) {
    await waitForEnter(
      `${context}: ログインまたは追加確認が必要です。ブラウザで済ませてから Enter を押してください。`,
    );
  } else {
    log(`${context}: ログイン中は画面を触りません。このウィンドウでログインしてください`);
  }
  const start = Date.now();
  const limit = 15 * 60_000;
  let lastBeat = 0;
  while (Date.now() - start < limit) {
    if (page.isClosed()) throw new Error(`${context}: 待ち中にブラウザが閉じられました`);
    if (!(await looksLikeGoogleLogin(page)) && !(await looksLikeCaptcha(page))) return;
    if (Date.now() - lastBeat >= 30_000) {
      lastBeat = Date.now();
      const left = Math.max(0, Math.round((limit - (Date.now() - start)) / 1000));
      log(`${context}: ログイン待ち（残り約 ${left}s）`);
    }
    await sleep(2000);
  }
  throw new Error(`${context}: ログイン待ちがタイムアウトしました`);
}
