import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { Locator, Page } from "playwright";
import { getChromeDownloadsPath } from "./browser.ts";
import { log, warn } from "./log.ts";
import { isRealVideoFile } from "./video-file.ts";

export async function saveFailureShot(page: Page, paperDir: string, name: string): Promise<string> {
  const dir = join(paperDir, "failures");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${name}.png`);
  if (page.isClosed()) return path;
  await page.screenshot({ path, fullPage: false, timeout: 5_000 }).catch(() => undefined);
  await Promise.race([
    dumpVisibleControls(page, join(dir, `${Date.now()}-${name}-dom.json`)),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]).catch(() => undefined);
  return path;
}

/** 失敗調査用。開いた shadow root 内の button / link も拾う */
export async function dumpVisibleControls(page: Page, destPath: string): Promise<void> {
  const payload = await page.evaluate(() => {
    type Row = { tag: string; role: string; aria: string; text: string };
    const rows: Row[] = [];
    const push = (el: Element) => {
      const text = ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const aria = el.getAttribute("aria-label") ?? "";
      if (!text && !aria) return;
      rows.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? "",
        aria,
        text,
      });
    };
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("button, a, [role='button'], [aria-label]")) {
        push(el);
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return { url: location.href, title: document.title, rows: rows.slice(0, 120) };
  });
  writeFileSync(destPath, JSON.stringify(payload, null, 2), "utf8");
}

export async function clickFirstByName(
  page: Page,
  names: (string | RegExp)[],
  opts: { timeoutMs?: number; exact?: boolean } = {},
): Promise<boolean> {
  const timeout = Math.min(opts.timeoutMs ?? 8000, 15_000);
  const probe = Math.min(800, timeout);
  for (const name of names) {
    const candidates = [
      page.getByRole("button", { name, exact: opts.exact }),
      page.getByRole("link", { name, exact: opts.exact }),
      page.getByRole("menuitem", { name, exact: opts.exact }),
      typeof name === "string"
        ? page.getByText(name, { exact: Boolean(opts.exact) })
        : page.getByText(name),
    ];
    for (const loc of candidates) {
      try {
        await loc.first().waitFor({ state: "visible", timeout: probe });
        await loc.first().click({ timeout });
        return true;
      } catch {
        /* 次の候補 */
      }
    }
  }
  return false;
}

export async function waitForAnyVisible(
  page: Page,
  locators: Locator[],
  timeoutMs: number,
): Promise<Locator | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const loc of locators) {
      if (await loc.first().isVisible({ timeout: 0 }).catch(() => false)) return loc.first();
    }
    await page.waitForTimeout(400);
  }
  return null;
}

export async function setFirstFileInput(
  page: Page,
  filePath: string,
  acceptHint?: string,
): Promise<boolean> {
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const input = inputs.nth(i);
    const accept = ((await input.getAttribute("accept", { timeout: 0 }).catch(() => "")) ?? "").toLowerCase();
    if (acceptHint && accept && !accept.includes(acceptHint.toLowerCase())) continue;
    await input.setInputFiles(filePath);
    return true;
  }
  if (n > 0) {
    await inputs.first().setInputFiles(filePath);
    return true;
  }
  return false;
}

export async function uploadViaChooserOrInput(
  page: Page,
  filePath: string,
  openButtons: (string | RegExp)[],
): Promise<void> {
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 }).catch(() => null);
  const clicked = await clickFirstByName(page, openButtons, { timeoutMs: 5000 });
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(filePath);
    return;
  }
  if (await setFirstFileInput(page, filePath, "pdf")) return;
  if (!clicked) {
    warn("アップロードボタンが見つかりませんでした。file input を再検索します。");
  }
  const ok = await setFirstFileInput(page, filePath);
  if (!ok) {
    throw new Error("PDF を渡す file chooser / input が見つかりませんでした");
  }
}

function copyIfReady(
  src: string | null | undefined,
  destPath: string,
  minBytes = 1_000,
): boolean {
  if (!src || !existsSync(src)) return false;
  try {
    if (statSync(src).size <= minBytes) return false;
    if (src !== destPath) copyFileSync(src, destPath);
    return existsSync(destPath) && statSync(destPath).size > minBytes;
  } catch {
    return false;
  }
}

export function downloadSearchDirs(): string[] {
  const dirs = [getChromeDownloadsPath(), join(homedir(), "Downloads")].filter((d): d is string => Boolean(d));
  const out: string[] = [];
  for (const dir of dirs) {
    try {
      if (existsSync(dir) && readdirSync(dir).length >= 0) out.push(dir);
    } catch {
      /* EPERM など */
    }
  }
  return out;
}

/** 直近に増えた PDF を dest へコピー。suggested があればその名前を優先 */
export function copyNewestPdfTo(
  destPath: string,
  opts: { sinceMs: number; suggestedName?: string; minBytes?: number },
): boolean {
  const minBytes = opts.minBytes ?? 80_000;
  const want = (opts.suggestedName || "").replace(/[/\\]/g, "");
  let best = "";
  let bestMtime = 0;
  for (const dir of downloadSearchDirs()) {
    for (const n of readdirSync(dir)) {
      if (!n.toLowerCase().endsWith(".pdf") || n.endsWith(".crdownload")) continue;
      const p = join(dir, n);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.size < minBytes || st.mtimeMs < opts.sinceMs - 2_000) continue;
      if (want && n === want) {
        if (copyIfReady(p, destPath)) {
          log(`保存: ${destPath}（${n}）`);
          return true;
        }
        return false;
      }
      if (st.mtimeMs >= bestMtime) {
        best = p;
        bestMtime = st.mtimeMs;
      }
    }
  }
  if (best && copyIfReady(best, destPath)) {
    log(`保存: ${destPath}（${best}）`);
    return true;
  }
  return false;
}

/** クリック後に増えた／伸びているファイルだけを新しいダウンロードとみなす */
export function isIncomingDownloadActive(prevSize: number | undefined, size: number): boolean {
  return prevSize == null || size > prevSize;
}

/** 未完了の .crdownload は使わない。動画は拡張子が無くても中身で判定する */
export function isFinishedDownloadCandidate(
  name: string,
  destExt: string,
  opts: { isVideoFile: boolean },
): boolean {
  if (name.endsWith(".crdownload")) return false;
  if (destExt === ".mp4" && opts.isVideoFile) return true;
  return name.toLowerCase().endsWith(destExt);
}

export async function waitForDownloadTo(
  page: Page,
  destPath: string,
  click: () => Promise<void>,
  timeoutMs: number,
  minBytes = 1_000,
): Promise<string> {
  const dirs = downloadSearchDirs();
  const seen = new Map<string, number>();
  for (const dir of dirs) {
    for (const n of readdirSync(dir)) {
      try {
        seen.set(join(dir, n), statSync(join(dir, n)).size);
      } catch {
        /* 既存ファイルの記録 */
      }
    }
  }
  const t0 = Date.now();
  const ext = extname(destPath).toLowerCase();
  // Playwright の Download.saveAs はタブ切断で打ち切るので、Chrome が書いたファイルを拾う
  await click();
  let lastCrKey = "";
  let lastCrChangeAt = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (
      existsSync(destPath) &&
      statSync(destPath).size > minBytes &&
      (ext !== ".mp4" || isRealVideoFile(destPath))
    ) {
      log(`保存: ${destPath}`);
      return destPath;
    }
    let crName = "";
    let crSize = 0;
    let crMtime = 0;
    for (const dir of dirs) {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        const prev = seen.get(p);
        const active = isIncomingDownloadActive(prev, st.size);
        if (ext === ".mp4" && n.endsWith(".crdownload") && active && isRealVideoFile(p)) {
          if (st.mtimeMs >= crMtime) {
            crName = n;
            crSize = st.size;
            crMtime = st.mtimeMs;
          }
          continue;
        }
        if (!isFinishedDownloadCandidate(n, ext, { isVideoFile: ext === ".mp4" && isRealVideoFile(p) })) {
          continue;
        }
        if (st.size <= minBytes) continue;
        if (!active && st.mtimeMs < t0 - 1_000) continue;
        await new Promise((r) => setTimeout(r, 400));
        try {
          if (statSync(p).size !== st.size) continue;
        } catch {
          continue;
        }
        if (copyIfReady(p, destPath, minBytes)) {
          if (ext === ".mp4" && !isRealVideoFile(destPath)) {
            try {
              unlinkSync(destPath);
            } catch {
              /* 次の候補へ */
            }
            continue;
          }
          log(`保存: ${destPath}（${n}）`);
          return destPath;
        }
      }
    }
    if (crName) {
      const key = `${crName}:${crSize}`;
      if (key !== lastCrKey) {
        lastCrKey = key;
        lastCrChangeAt = Date.now();
        log(`動画ダウンロード中: ${crSize} bytes（${crName}）`);
      } else if (Date.now() - lastCrChangeAt > 20_000) {
        let alive = false;
        try {
          alive = page.context().pages().some((p) => !p.isClosed());
        } catch {
          alive = false;
        }
        if (!alive) {
          throw new Error(`動画ダウンロードが止まりました: ${crSize} bytes（${crName}）`);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (copyIfReady(destPath, destPath, minBytes) && (ext !== ".mp4" || isRealVideoFile(destPath))) {
    log(`保存: ${destPath}（既存ファイル）`);
    return destPath;
  }
  throw new Error(`成果物が ${timeoutMs}ms 以内に保存できませんでした`);
}

export async function bodyIncludes(page: Page, re: RegExp): Promise<boolean> {
  const t = await page.locator("body").innerText().catch(() => "");
  return re.test(t);
}

/** Playwright 既定の 30 秒待ちを避け、見えない欄はすぐ諦める */
export async function fillIfVisible(
  loc: Locator,
  value: string,
  label: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (!value.trim()) return false;
  if (!(await loc.first().isVisible({ timeout: 0 }).catch(() => false))) {
    warn(`${label} が見えないのでスキップ`);
    return false;
  }
  try {
    await loc.first().fill(value, { timeout: timeoutMs });
    return true;
  } catch (e) {
    warn(`${label} の入力をスキップ: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    return false;
  }
}
