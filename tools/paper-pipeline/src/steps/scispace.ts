import type { Page } from "playwright";
import { assertPageAlive, isTargetClosedError, pageAlive } from "../browser.ts";
import { containsForeignPdf, extractSciSpaceCardMeta } from "../scispace-card.ts";
import {
  canonicalSciSpaceRecordUrl,
  isSciSpaceRecordUrl,
  pickSciSpaceRecordUrl,
} from "../scispace-record-url.ts";
import { firstLine, log, warn } from "../log.ts";
import { isCompleted, markCompleted, type PaperState } from "../state.ts";
import { clickFirstByName, saveFailureShot, uploadViaChooserOrInput } from "../ui.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pageText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
}

async function isNotebooksFilesView(page: Page): Promise<boolean> {
  const t = await pageText(page);
  return /Upload PDFs/i.test(t) && /Files\s*\(/i.test(t);
}

function folderPath(folderUrl: string): string {
  try {
    return new URL(folderUrl).pathname.replace(/\/+$/, "");
  } catch {
    return folderUrl;
  }
}

function isOnSpecifiedFolder(page: Page, folderUrl: string): boolean {
  try {
    return new URL(page.url()).pathname.replace(/\/+$/, "") === folderPath(folderUrl);
  } catch {
    return page.url().includes(folderPath(folderUrl));
  }
}

function isAuthUrl(page: Page): boolean {
  try {
    return /accounts\.google\.com|signin\.google|\/signin|\/login/i.test(page.url());
  } catch {
    return false;
  }
}

async function needsSciSpaceLogin(page: Page): Promise<boolean> {
  if (isAuthUrl(page)) return true;
  const visibleLogin =
    (await page.locator('input[type="password"]').first().isVisible({ timeout: 0 }).catch(() => false)) ||
    (await page.locator('input[type="email"]').first().isVisible({ timeout: 0 }).catch(() => false));
  if (!visibleLogin) return false;
  const t = await pageText(page);
  return /log in|sign in|ログイン/i.test(t);
}

async function gotoSpecifiedFolder(page: Page, folderUrl: string): Promise<void> {
  log("SciSpace フォルダへ移動します");
  try {
    await page.goto(folderUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    if (isTargetClosedError(e) || page.isClosed() || !(await pageAlive(page))) {
      throw new Error("SciSpace を開く途中でブラウザが閉じられました");
    }
    warn(`SciSpace の初回移動に失敗: ${firstLine(e)}`);
    await assertPageAlive(page);
    await page.goto(folderUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
}

async function waitUntilSpecifiedFolderReady(page: Page, folderUrl: string): Promise<void> {
  log(`SciSpace 指定フォルダを開きます: ${folderUrl}`);
  await assertPageAlive(page);
  if (isAuthUrl(page)) {
    log("SciSpace: ログイン画面のため遷移しません");
  } else if (!(await needsSciSpaceLogin(page)) && !isOnSpecifiedFolder(page, folderUrl)) {
    await gotoSpecifiedFolder(page, folderUrl);
  }
  const deadline = Date.now() + 15 * 60_000;
  let loggedWait = false;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    if (page.isClosed() || !(await pageAlive(page))) {
      throw new Error("SciSpace 待ち中にブラウザが閉じられました");
    }
    if (await isNotebooksFilesView(page)) {
      log("SciSpace Files ビューを確認");
      return;
    }
    if (isAuthUrl(page) || (await needsSciSpaceLogin(page))) {
      if (!loggedWait) {
        log("SciSpace: ログイン中は画面を触りません。このウィンドウでログインしてください");
        loggedWait = true;
      }
    }
    if (Date.now() - lastBeat >= 30_000) {
      lastBeat = Date.now();
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      const url = (() => {
        try {
          return page.url().slice(0, 80);
        } catch {
          return "(url不明)";
        }
      })();
      log(`SciSpace 待ち（残り約 ${left}s） url=${url}`);
    }
    await sleep(2000);
  }
  throw new Error(`SciSpace の指定フォルダを開けませんでした: ${folderUrl}`);
}

async function openNotebooksFilesView(page: Page, folderUrl: string): Promise<void> {
  if (await isNotebooksFilesView(page) && isOnSpecifiedFolder(page, folderUrl)) return;
  await waitUntilSpecifiedFolderReady(page, folderUrl);
}

async function uploadPdfToSciSpace(page: Page, pdfPath: string): Promise<void> {
  await clickFirstByName(page, [/^Files/, /ファイル/, /Library/i], { timeoutMs: 4_000 }).catch(
    () => undefined,
  );
  await uploadViaChooserOrInput(page, pdfPath, [
    /Upload PDFs/i,
    /Upload papers/i,
    /Upload PDF/i,
    /Add papers/i,
    /PDF をアップロード/,
    /論文をアップロード/,
  ]);
}

function usableSciSpacePaste(
  card: ReturnType<typeof extractSciSpaceCardMeta>,
  filename: string,
): string {
  const stem = filename.replace(/\.pdf$/i, "").toLowerCase();
  const titleKey = card.title.replace(/\.pdf$/i, "").trim().toLowerCase();
  const titleIsFile = !titleKey || titleKey === stem || titleKey === filename.toLowerCase();
  if (titleIsFile && !card.authors && !card.venue && !card.publicationYear) return "";
  return card.paste.slice(0, 4000);
}

async function filterFilesList(page: Page, filename: string): Promise<void> {
  const stem = filename.replace(/\.pdf$/i, "");
  const filtered = await Promise.race([
    page
      .evaluate((q) => {
        const inputs = Array.from(document.querySelectorAll("input"));
        const el = inputs.find((i) => {
          const hint = `${i.type} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`;
          return /search|filter|find|検索/i.test(hint);
        });
        if (!el) return false;
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        desc?.set?.call(el, q);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, stem)
      .catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (filtered) await sleep(1200);
}

async function readFilesRowText(page: Page, filename: string): Promise<string> {
  const stem = filename.replace(/\.pdf$/i, "");
  return Promise.race([
    page
      .evaluate(
        ({ filename: name, stem: st }) => {
          const hay = document.body?.innerText ?? "";
          const nodes = Array.from(
            document.querySelectorAll("tr, [role='row'], li, article, [role='listitem']"),
          );
          const scored: { t: string; n: number; exact: number }[] = [];
          for (const el of nodes) {
            const t = ((el as HTMLElement).innerText ?? "").trim();
            if (!t) continue;
            const exact = t.includes(name) ? 1 : st && t.includes(st) ? 0 : -1;
            if (exact < 0) continue;
            scored.push({ t, n: t.length, exact });
          }
          scored.sort((a, b) => b.exact - a.exact || a.n - b.n);
          const best = scored[0]?.t ?? "";
          if (best && best.length <= 4000) return best;
          if (best) return best.slice(0, 4000);
          const idx = hay.indexOf(name) >= 0 ? hay.indexOf(name) : hay.indexOf(st);
          if (idx < 0) return "";
          return hay.slice(idx, idx + 1800).trim();
        },
        { filename, stem },
      )
      .catch(() => ""),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 5_000)),
  ]);
}

async function collectRecordHrefRows(page: Page): Promise<{ href: string; text: string; row: string }[]> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => {
        const el = a as HTMLAnchorElement;
        const row = el.closest("tr, li, article, [role='row']") as HTMLElement | null;
        return {
          href: el.href || "",
          text: (el.innerText || "").slice(0, 200),
          row: (row?.innerText || "").slice(0, 800),
        };
      }),
    )
    .catch(() => [] as { href: string; text: string; row: string }[]);
}

async function findSciSpaceRecordUrl(
  page: Page,
  folderUrl: string,
  filename: string,
): Promise<string> {
  const fromList = pickSciSpaceRecordUrl(await collectRecordHrefRows(page), filename);
  if (fromList) return fromList;

  const popupP = page.context().waitForEvent("page", { timeout: 8_000 }).catch(() => null);
  const name = page.getByText(filename, { exact: false }).first();
  if (await name.isVisible({ timeout: 0 }).catch(() => false)) {
    await name.click({ timeout: 8_000 }).catch(() => undefined);
  } else {
    const stem = filename.replace(/\.pdf$/i, "");
    await page.getByText(stem, { exact: false }).first().click({ timeout: 8_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(1200);
  if (isSciSpaceRecordUrl(page.url())) {
    const url = canonicalSciSpaceRecordUrl(page.url());
    await page.goto(folderUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    return url;
  }
  const popup = await popupP;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
    const href = popup.url();
    await popup.close().catch(() => undefined);
    if (isSciSpaceRecordUrl(href)) return canonicalSciSpaceRecordUrl(href);
  }
  return pickSciSpaceRecordUrl(await collectRecordHrefRows(page), filename);
}

export async function captureSciSpaceCardMeta(
  page: Page,
  opts: { folderUrl: string; filename: string; paperDir: string; state: PaperState },
): Promise<void> {
  const { folderUrl, filename, paperDir, state } = opts;
  try {
    await openNotebooksFilesView(page, folderUrl);
    log("SciSpace: Files 上で行を探します");
    await filterFilesList(page, filename);
    const filesPaste = await readFilesRowText(page, filename);
    if (!filesPaste) {
      warn(`Files 行を ${filename} では取れませんでした。ファイル名をタイトルにします`);
    } else if (containsForeignPdf(filesPaste, filename)) {
      warn(`SciSpace Files の取得に他の PDF が混ざっていたので、${filename} のカードだけ使います`);
    }

    const card = extractSciSpaceCardMeta(filesPaste, filename);
    state.tldr = card.tldr || "";
    state.title = card.title || filename.replace(/\.pdf$/i, "");
    if (card.venue) state.venue = card.venue;
    state.filesPaste = usableSciSpacePaste(card, filename);
    if (!state.filesPaste && filesPaste) {
      warn("SciSpace 行は取れましたが貼り付け用のメタが足りないため、貼り付けはしません");
    }
    if (!isSciSpaceRecordUrl(state.scispaceUrl)) {
      state.scispaceUrl = await findSciSpaceRecordUrl(page, folderUrl, filename);
    }
    if (!isSciSpaceRecordUrl(state.scispaceUrl)) {
      throw new Error(`SciSpace の個別ページ URL が見つかりません（${filename}）`);
    }

    log(
      `SciSpace メタ: title=${state.title.slice(0, 80)} doi=${state.doi || "(なし)"} tldr=${state.tldr ? "あり" : "なし"}`,
    );
    log(`SciSpace 個別ページ: ${state.scispaceUrl}`);
  } catch (e) {
    await saveFailureShot(page, paperDir, "scispace-meta");
    throw e;
  }
}

export async function captureSciSpaceRecordUrl(
  page: Page,
  opts: { folderUrl: string; filename: string; paperDir: string; state: PaperState },
): Promise<string> {
  const { folderUrl, filename, paperDir, state } = opts;
  if (isSciSpaceRecordUrl(state.scispaceUrl)) return state.scispaceUrl;
  try {
    await openNotebooksFilesView(page, folderUrl);
    await filterFilesList(page, filename);
    const url = await findSciSpaceRecordUrl(page, folderUrl, filename);
    if (!isSciSpaceRecordUrl(url)) {
      throw new Error(`SciSpace の個別ページ URL が見つかりません（${filename}）`);
    }
    state.scispaceUrl = url;
    log(`SciSpace 個別ページ: ${url}`);
    return url;
  } catch (e) {
    await saveFailureShot(page, paperDir, "scispace-record");
    throw e;
  }
}

export async function runSciSpace(
  page: Page,
  opts: {
    folderUrl: string;
    pdfPath: string;
    filename: string;
    paperDir: string;
    state: PaperState;
  },
): Promise<void> {
  const { folderUrl, pdfPath, filename, paperDir, state } = opts;
  const should = (id: Parameters<typeof isCompleted>[1]) => !isCompleted(state, id);

  try {
    if (should("sci-upload")) {
      await openNotebooksFilesView(page, folderUrl);
      await uploadPdfToSciSpace(page, pdfPath);
      const stem = filename.replace(/\.pdf$/i, "");
      const start = Date.now();
      let found = false;
      while (Date.now() - start < 180_000) {
        if (page.isClosed() || !(await pageAlive(page))) {
          throw new Error("SciSpace アップロード待ち中にブラウザが閉じられました");
        }
        const body = await pageText(page);
        if (body.includes(filename) || body.includes(stem)) {
          found = true;
          break;
        }
        await sleep(2000);
      }
      if (!found) {
        throw new Error("SciSpace の Files に PDF 名が出ていません（アップロード未完了）");
      }
      markCompleted(state, "sci-upload");
    }

    if (should("sci-meta")) {
      log("SciSpace メタを集めます");
      await captureSciSpaceCardMeta(page, { folderUrl, filename, paperDir, state });
      markCompleted(state, "sci-meta");
    } else if (!isSciSpaceRecordUrl(state.scispaceUrl)) {
      await captureSciSpaceRecordUrl(page, { folderUrl, filename, paperDir, state });
    }
  } catch (e) {
    await saveFailureShot(page, paperDir, "scispace");
    throw e;
  }
}
