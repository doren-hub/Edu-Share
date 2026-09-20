import type { Page } from "playwright";
import { assertPageAlive, isTargetClosedError, pageAlive, recoverStuckPage } from "../browser.ts";
import {
  containsForeignPdf,
  doiFromHrefOrText,
  extractSciSpaceCardMeta,
  looksLikeCitationTitle,
  looksLikeSciSpaceNav,
  looksLikeVenueLine,
  pickBestSciSpaceCardText,
  isolateSciSpaceCardText,
  rawFilesCardPaste,
  stripTldrSnippetNumbers,
  titleLooksLikeFilename,
  tldrUsable,
  descriptionUsable,
} from "../scispace-card.ts";
import { arxivIdFromFilename, fetchArxivAbstract } from "../arxiv-abstract.ts";
import {
  canonicalSciSpaceRecordUrl,
  isSciSpaceRecordUrl,
  pickSciSpaceRecordUrl,
} from "../scispace-record-url.ts";
import { looksLikeSciSpaceFilesTable } from "../scispace-files-view.ts";
import { firstLine, log, warn } from "../log.ts";
import { isCompleted, markCompleted, saveState, type PaperState } from "../state.ts";
import { saveFailureShot, uploadViaChooserOrInput } from "../ui.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pageText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
}

async function isNotebooksFilesView(page: Page, folderUrl: string): Promise<boolean> {
  if (!isOnSpecifiedFolder(page, folderUrl)) return false;
  const upload = await page
    .getByRole("button", { name: /Upload PDFs/i })
    .first()
    .isVisible({ timeout: 0 })
    .catch(() => false);
  const uploadedOn = await page.getByText(/Uploaded on/i).first().isVisible({ timeout: 0 }).catch(() => false);
  const tldrCol = await page.getByText(/^TL;DR$/).first().isVisible({ timeout: 0 }).catch(() => false);
  const filesCount = await page.getByText(/Files\s*\(\d+\)/).first().isVisible({ timeout: 0 }).catch(() => false);
  if (upload && (uploadedOn || tldrCol)) return true;
  if (upload && filesCount && uploadedOn) return true;
  const t = await pageText(page);
  if (looksLikeSciSpaceFilesTable(t)) return true;
  return false;
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

async function clickFolderFilesTab(page: Page): Promise<boolean> {
  const names = [/Files\s*\(\d+\)/];
  for (const name of names) {
    const locs = [
      page.getByRole("tab", { name }),
      page.getByRole("button", { name }),
      page.getByRole("link", { name }),
      page.getByText(name),
    ];
    for (const loc of locs) {
      const el = loc.first();
      if (!(await el.isVisible({ timeout: 350 }).catch(() => false))) continue;
      await el.click({ timeout: 4_000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function restoreFolderFilesTable(page: Page, folderUrl: string): Promise<void> {
  if (isAuthUrl(page) || (await needsSciSpaceLogin(page))) return;
  if (!isOnSpecifiedFolder(page, folderUrl)) {
    await gotoSpecifiedFolder(page, folderUrl);
    await sleep(800);
  }
  if (await isNotebooksFilesView(page, folderUrl)) return;
  const clicked = await clickFolderFilesTab(page);
  if (clicked) {
    log("SciSpace: Files タブを開きます");
    await sleep(1_200);
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
  let lastFilesClick = 0;
  while (Date.now() < deadline) {
    if (page.isClosed() || !(await pageAlive(page))) {
      throw new Error("SciSpace 待ち中にブラウザが閉じられました");
    }
    if (await isNotebooksFilesView(page, folderUrl)) {
      log("SciSpace Files 表を確認");
      return;
    }
    if (isAuthUrl(page) || (await needsSciSpaceLogin(page))) {
      if (!loggedWait) {
        log("SciSpace: ログイン中は画面を触りません。このウィンドウでログインしてください");
        loggedWait = true;
      }
    } else if (Date.now() - lastFilesClick >= 4_000) {
      lastFilesClick = Date.now();
      await restoreFolderFilesTable(page, folderUrl);
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
  if (await isNotebooksFilesView(page, folderUrl)) return;
  await waitUntilSpecifiedFolderReady(page, folderUrl);
}

async function uploadPdfToSciSpace(page: Page, pdfPath: string): Promise<void> {
  await clickFolderFilesTab(page);
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

async function setFilesSearch(page: Page, folderUrl: string, query: string): Promise<boolean> {
  const typed = await Promise.race([
    page
      .evaluate((q) => {
        const vis = (el: Element) => {
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.visibility !== "hidden" && s.display !== "none" && r.width > 2 && r.height > 2;
        };
        const upload = Array.from(document.querySelectorAll("button, a, [role='button']")).find((el) => {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          return vis(el) && /^Upload PDFs$/i.test(t);
        });
        if (!upload) return false;
        let root: HTMLElement | null = upload.parentElement;
        let inputs: HTMLInputElement[] = [];
        for (let i = 0; i < 12 && root; i++) {
          inputs = Array.from(root.querySelectorAll("input")).filter((inp) => {
            if (!vis(inp)) return false;
            const hint = `${inp.type} ${inp.placeholder} ${inp.getAttribute("aria-label") ?? ""} ${inp.className}`;
            if (/chat|ask|message|prompt|composer/i.test(hint)) return false;
            return inp.type === "search" || inp.type === "text" || /search|filter|find|検索|file|folder/i.test(hint);
          });
          if (inputs.length) break;
          root = root.parentElement;
        }
        const el = inputs[0];
        if (!el) return false;
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        desc?.set?.call(el, q);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, query)
      .catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!typed) return false;
  await sleep(800);
  if (!(await isNotebooksFilesView(page, folderUrl))) {
    warn("SciSpace: 検索でフォルダの Files を出たので戻ります");
    await restoreFolderFilesTable(page, folderUrl);
    return false;
  }
  return true;
}

async function fillFilesListSearch(page: Page, folderUrl: string, query: string): Promise<boolean> {
  const sort = page.getByRole("button", { name: /^Sort$/i }).first();
  if (await sort.isVisible({ timeout: 800 }).catch(() => false)) {
    const sortBox = await sort.boundingBox().catch(() => null);
    const nextBtn = sort.locator("xpath=following::button[1]");
    if (await nextBtn.isVisible({ timeout: 400 }).catch(() => false)) {
      await nextBtn.click({ timeout: 3_000 }).catch(() => undefined);
      await sleep(400);
    }
    const inputs = page.locator("input:visible");
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const box = await inputs.nth(i).boundingBox().catch(() => null);
      if (!box) continue;
      const nearSort = Boolean(sortBox && Math.abs(box.y - sortBox.y) < 90 && box.x >= sortBox.x - 40);
      const inFilesHeader = box.x > 220 && box.y > 70 && box.y < 320;
      if (!nearSort && !inFilesHeader) continue;
      await inputs.nth(i).fill(query).catch(() => undefined);
      await inputs.nth(i).press("Enter").catch(() => undefined);
      await sleep(900);
      if (!(await isNotebooksFilesView(page, folderUrl))) {
        warn("SciSpace: 一覧検索で Files を出たので戻ります");
        await restoreFolderFilesTable(page, folderUrl);
        return false;
      }
      return true;
    }
  }
  return setFilesSearch(page, folderUrl, query);
}

async function filesNameVisible(page: Page, filename: string): Promise<boolean> {
  const loc = page.getByText(filename, { exact: false }).first();
  if (!(await loc.isVisible({ timeout: 800 }).catch(() => false))) return false;
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  await sleep(300);
  return true;
}

async function scrollFilesForName(page: Page, filename: string): Promise<boolean> {
  if (await filesNameVisible(page, filename)) return true;
  const firstPdf = page.getByText(/\.pdf\b/).first();
  if (await firstPdf.isVisible({ timeout: 800 }).catch(() => false)) {
    await firstPdf.hover().catch(() => undefined);
    await sleep(200);
  }
  for (let i = 0; i < 80; i++) {
    if (await filesNameVisible(page, filename)) return true;
    await page.mouse.wheel(0, 900);
    await sleep(160);
  }
  return filesNameVisible(page, filename);
}

async function filterFilesList(page: Page, folderUrl: string, filename: string, title = ""): Promise<void> {
  if (!(await isNotebooksFilesView(page, folderUrl))) {
    await restoreFolderFilesTable(page, folderUrl);
  }
  if (await filesNameVisible(page, filename)) return;

  const stem = filename.replace(/\.pdf$/i, "");
  const queries = [stem, filename, stem.replace(/\./g, " "), title.slice(0, 48)].filter((q) => q.trim().length >= 4);
  for (const q of queries) {
    if (!(await isNotebooksFilesView(page, folderUrl))) {
      await restoreFolderFilesTable(page, folderUrl);
    }
    if (!(await isNotebooksFilesView(page, folderUrl))) {
      warn("SciSpace: Files 表に戻れないので検索しません");
      return;
    }
    if (await fillFilesListSearch(page, folderUrl, q)) {
      await sleep(400);
      if (await filesNameVisible(page, filename)) return;
    }
  }
  await fillFilesListSearch(page, folderUrl, "");
  await sleep(400);
  await scrollFilesForName(page, filename);
}

type FilesCardCandidates = { texts: string[]; dois: string[] };

async function readFilesRowCardText(page: Page, filename: string): Promise<string> {
  const name = page.getByText(filename, { exact: false }).first();
  if (!(await name.isVisible({ timeout: 800 }).catch(() => false))) return "";
  const handle = await name.elementHandle().catch(() => null);
  if (handle) {
    const band = String(
      await handle
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          const mid = r.top + r.height / 2;
          const seen = new Set<string>();
          const parts: { x: number; t: string }[] = [];
          const walk = (root: Document | ShadowRoot) => {
            for (const n of Array.from(root.querySelectorAll("*"))) {
              if (n.shadowRoot) walk(n.shadowRoot);
              const hr = n.getBoundingClientRect();
              if (hr.height < 4 || hr.width < 4) continue;
              if (Math.abs(hr.top + hr.height / 2 - mid) > 52) continue;
              if (n.children.length > 4) continue;
              const t = ((n as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
              if (!t || t.length > 1600 || seen.has(t)) continue;
              seen.add(t);
              parts.push({ x: hr.left, t });
            }
          };
          walk(document);
          parts.sort((a, b) => a.x - b.x || a.t.length - b.t.length);
          return parts.map((p) => p.t).join("\n");
        })
        .catch(() => ""),
    ).trim();
    await handle.dispose().catch(() => undefined);
    const isolated = isolateSciSpaceCardText(band, filename);
    const raw = rawFilesCardPaste(band, filename) || rawFilesCardPaste(isolated, filename);
    if (raw) return raw;
  }
  let loc = name;
  let best = "";
  for (let i = 0; i < 12; i++) {
    const t = ((await loc.innerText({ timeout: 1_500 }).catch(() => "")) || "").trim();
    const raw = rawFilesCardPaste(t, filename);
    if (raw && !containsForeignPdf(raw, filename)) {
      return raw;
    }
    const isolated = isolateSciSpaceCardText(t, filename);
    if (!isolated) {
      loc = loc.locator("xpath=..");
      continue;
    }
    const stem = filename.replace(/\.pdf$/i, "");
    if (!isolated.includes(filename) && !isolated.includes(stem)) {
      loc = loc.locator("xpath=..");
      continue;
    }
    if (containsForeignPdf(isolated, filename)) {
      loc = loc.locator("xpath=..");
      continue;
    }
    if (isolated.length > best.length) best = isolated;
    loc = loc.locator("xpath=..");
  }
  return best.slice(0, 4000);
}

async function collectFilesCardCandidates(
  page: Page,
  filename: string,
): Promise<FilesCardCandidates> {
  const stem = filename.replace(/\.pdf$/i, "");
  const empty: FilesCardCandidates = { texts: [], dois: [] };
  const fromDom = await Promise.race([
    page
      .evaluate(
        ({ filename: name, stem: st }) => {
          const texts: string[] = [];
          const dois: string[] = [];
          const seen = new Set<string>();
          const pushText = (raw: string) => {
            const t = raw.trim();
            if (!t || t.length > 8000 || seen.has(t)) return;
            seen.add(t);
            texts.push(t.slice(0, 4000));
          };
          const pushDois = (root: Element) => {
            for (const a of Array.from(root.querySelectorAll("a[href]"))) {
              const href = (a as HTMLAnchorElement).href || "";
              if (/doi\.org\/10\.|doi:10\./i.test(href)) dois.push(href);
            }
          };
          const walkUp = (el: Element) => {
            let cur: HTMLElement | null = el as HTMLElement;
            for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
              pushText(cur.innerText ?? "");
              pushDois(cur);
              cur = cur.parentElement;
            }
          };

          const nameHits = Array.from(
            document.querySelectorAll("a, span, div, p, td, li, h2, h3, h4"),
          ).filter((el) => {
            const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            return t === name || t === st || t.endsWith(name);
          });
          for (const el of nameHits) walkUp(el);

          for (const el of Array.from(
            document.querySelectorAll("tr, [role='row'], li, article, [role='listitem']"),
          )) {
            const t = ((el as HTMLElement).innerText ?? "").trim();
            if (!t.includes(name) && !(st && t.includes(st))) continue;
            pushText(t);
            pushDois(el);
          }

          if (texts.length === 0) {
            const hay = document.body?.innerText ?? "";
            const idx = hay.indexOf(name) >= 0 ? hay.indexOf(name) : hay.indexOf(st);
            if (idx >= 0) pushText(hay.slice(idx, idx + 2500));
          }
          return { texts: texts.slice(0, 60), dois: dois.slice(0, 20) };
        },
        { filename, stem },
      )
      .catch(() => empty),
    new Promise<FilesCardCandidates>((resolve) => setTimeout(() => resolve(empty), 5_000)),
  ]);
  const row = await readFilesRowCardText(page, filename);
  return {
    texts: [row, ...fromDom.texts].filter((t) => t.trim()),
    dois: fromDom.dois,
  };
}

async function collectRecordHrefRows(page: Page): Promise<{ href: string; text: string; row: string }[]> {
  const fromDom = await page
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
  const extra: { href: string; text: string; row: string }[] = [];
  const recs = page.locator('a[href*="/records/"]');
  const n = Math.min(await recs.count().catch(() => 0), 80);
  const base = (() => {
    try {
      return page.url();
    } catch {
      return "https://scispace.com/";
    }
  })();
  for (let i = 0; i < n; i++) {
    const raw = (await recs.nth(i).getAttribute("href").catch(() => "")) || "";
    let href = raw;
    try {
      href = new URL(raw, base).href;
    } catch {
      href = raw;
    }
    const text = ((await recs.nth(i).innerText().catch(() => "")) || "").slice(0, 200);
    extra.push({ href, text, row: text });
  }
  return [...fromDom, ...extra];
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

async function readFilesRowTldr(page: Page, filename: string): Promise<string> {
  const opener = /((?:The paper|This paper|The study|This study|本研究[はが]|本論文[はが])[\s\S]{40,1500})/;
  const name = page.getByText(filename, { exact: false }).first();
  if (!(await name.isVisible({ timeout: 500 }).catch(() => false))) return "";
  let loc = name;
  for (let i = 0; i < 12; i++) {
    const t = ((await loc.innerText({ timeout: 1_500 }).catch(() => "")) || "").trim();
    const pdfs = t.match(/[\w.-]+\.pdf/gi) || [];
    const uniq = [...new Set(pdfs.map((p) => p.toLowerCase()))];
    if (uniq.length > 1) {
      loc = loc.locator("xpath=..");
      continue;
    }
    const m = t.replace(/\s+/g, " ").match(opener);
    if (
      m?.[1] &&
      (t.includes(filename) || t.toLowerCase().includes(filename.replace(/\.pdf$/i, "").toLowerCase()))
    ) {
      return m[1].replace(/\s+/g, " ").trim().slice(0, 2000);
    }
    loc = loc.locator("xpath=..");
  }
  return "";
}

async function readFilesColumnTldr(page: Page, filename: string): Promise<string> {
  const raw = String(
    await page
      .evaluate(
        `(function () {
      const name = ${JSON.stringify(filename)};
      const stem = name.replace(/\\.pdf$/i, "");
      const opener = /^(The paper|This paper|The study|This study|本研究|本論文)\\b/i;
      const looksName = (t) => t === name || t === stem || t.endsWith(name);
      const nodes = Array.from(document.querySelectorAll("a, span, div, p, td, li, h2, h3, h4"));
      const hit = nodes.find((el) => looksName((el.textContent || "").replace(/\\s+/g, " ").trim()));
      const fromKids = (root) => {
        const whole = ((root.innerText || "") + "");
        const pdfs = whole.match(/[\\w.-]+\\.pdf/gi) || [];
        const uniq = [];
        for (const p of pdfs) {
          const k = p.toLowerCase();
          if (uniq.indexOf(k) < 0) uniq.push(k);
        }
        if (uniq.length > 1) return "";
        const kids = Array.from(root.children || []);
        let openerHit = "";
        for (const k of kids) {
          const t = ((k.innerText || "") + "").replace(/\\s+/g, " ").trim();
          if (t.length < 80) continue;
          if (t.indexOf(name) >= 0) continue;
          if (/pdf upload|uploaded on/i.test(t)) continue;
          if ((t.match(/[\\w.-]+\\.pdf/gi) || []).length) continue;
          if (opener.test(t) && t.length > openerHit.length) openerHit = t;
        }
        if (openerHit) return openerHit.slice(0, 2000);
        return "";
      };
      let cur = hit;
      for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
        const got = fromKids(cur);
        if (got) return got;
        cur = cur.parentElement;
      }
      const rows = Array.from(document.querySelectorAll('[role="row"], tr, article, li'));
      for (const row of rows) {
        const text = ((row.innerText || "") + "").trim();
        if (!text.includes(name) && !text.includes(stem + ".pdf")) continue;
        const got = fromKids(row);
        if (got) return got;
        const m = text.replace(/\\s+/g, " ").match(/((?:The paper|This paper|本研究[はが]|本論文[はが])[\\s\\S]{40,1500})/);
        if (m && m[1]) return m[1].replace(/\\s+/g, " ").trim().slice(0, 2000);
      }
      return "";
    })()`,
      )
      .catch(() => ""),
  ).trim();
  return raw;
}

export async function captureSciSpaceCardMeta(
  page: Page,
  opts: { folderUrl: string; filename: string; paperDir: string; state: PaperState },
): Promise<void> {
  const { folderUrl, filename, paperDir, state } = opts;
  try {
    if (!(await recoverStuckPage(page))) {
      throw new Error("ブラウザが閉じられています");
    }
    await openNotebooksFilesView(page, folderUrl);
    await filterFilesList(page, folderUrl, filename, state.title);
    if (looksLikeSciSpaceNav(state.tldr)) state.tldr = "";
    if (!(await isNotebooksFilesView(page, folderUrl))) {
      warn("SciSpace: Files 以外の画面に出たのでフォルダへ戻ります");
      await openNotebooksFilesView(page, folderUrl);
    }
    log("SciSpace: Files の TL;DR 列をコピーします");
    let filesTldr = "";
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      if (!(await isNotebooksFilesView(page, folderUrl))) {
        await restoreFolderFilesTable(page, folderUrl);
      }
      if (!(await filesNameVisible(page, filename))) {
        await filterFilesList(page, folderUrl, filename, state.title);
      }
      filesTldr = await readFilesRowTldr(page, filename);
      if (!(descriptionUsable(filesTldr) || tldrUsable(filesTldr))) {
        filesTldr = await readFilesColumnTldr(page, filename);
      }
      if (descriptionUsable(filesTldr) || tldrUsable(filesTldr)) break;
      await sleep(2_000);
    }
    if (!(descriptionUsable(filesTldr) || tldrUsable(filesTldr))) {
      const dump = String(
        await page
          .evaluate(
            `(function () {
        const name = ${JSON.stringify(filename)};
        const el = Array.from(document.querySelectorAll("a, span, div, p, td")).find(function (e) {
          const t = (e.textContent || "").replace(/\\s+/g, " ").trim();
          return t === name || t.indexOf(name) >= 0;
        });
        if (!el) {
          var hay = (document.body && document.body.innerText) || "";
          return "filename node なし bodyHas=" + (hay.indexOf(name) >= 0) + " stemHas=" + (hay.indexOf(${JSON.stringify(filename.replace(/\.pdf$/i, ""))}) >= 0) + " sample=" + hay.replace(/\\s+/g, " ").slice(0, 180);
        }
        var cur = el;
        var info = [];
        for (var i = 0; i < 8 && cur && cur !== document.body; i++) {
          var kids = Array.from(cur.children).map(function (k) {
            var t = ((k.innerText || "") + "").replace(/\\s+/g, " ").trim();
            return t.slice(0, 70) + " len=" + t.length;
          });
          info.push("L" + i + " kids=" + kids.length + " " + kids.join(" || "));
          cur = cur.parentElement;
        }
        return info.join("\\n");
      })()`,
          )
          .catch((e) => String(e)),
      );
      warn(`Files TL;DR 列が取れません（${filename}）\n${dump.slice(0, 1200)}`);
      await restoreFolderFilesTable(page, folderUrl);
      await setFilesSearch(page, folderUrl, "");
      await sleep(1_500);
      if (!(await isNotebooksFilesView(page, folderUrl))) {
        throw new Error(`SciSpace の Files 表を開けません（${filename}）`);
      }
      filesTldr = await readFilesColumnTldr(page, filename);
    }
    const found = await collectFilesCardCandidates(page, filename);
    let filesPaste = "";
    for (const t of found.texts) {
      filesPaste = rawFilesCardPaste(t, filename);
      if (filesPaste) break;
    }
    if (!filesPaste) {
      filesPaste = rawFilesCardPaste(pickBestSciSpaceCardText(found.texts, filename), filename);
    }
    if (filesPaste && containsForeignPdf(filesPaste, filename)) {
      warn(`SciSpace Files の取得に他の PDF が混ざっていたので、${filename} のカードだけ使います`);
      filesPaste = rawFilesCardPaste(filesPaste, filename);
    }
    applyExtractedCard(state, filename, extractSciSpaceCardMeta(filesPaste, filename), found.dois);
    if (descriptionUsable(filesTldr) || tldrUsable(filesTldr)) {
      state.tldr = stripTldrSnippetNumbers(filesTldr).slice(0, 2000);
      log("SciSpace: Files の TL;DR 列を使います");
    }
    if (filesPaste) {
      state.filesPaste = filesPaste;
      log("SciSpace: Files 行を加工せず貼り付けます");
    }
    if (!rawFilesCardPaste(state.filesPaste, filename)) {
      throw new Error(`SciSpace Files 列のメタが取れません（${filename}）`);
    }

    if (!(await isNotebooksFilesView(page, folderUrl))) {
      await restoreFolderFilesTable(page, folderUrl);
      await filterFilesList(page, folderUrl, filename, state.title);
    }
    if (!isSciSpaceRecordUrl(state.scispaceUrl)) {
      state.scispaceUrl = await findSciSpaceRecordUrl(page, folderUrl, filename);
    }
    if (!isSciSpaceRecordUrl(state.scispaceUrl)) {
      throw new Error(`SciSpace の個別ページ URL が見つかりません（${filename}）`);
    }

    if (!(descriptionUsable(state.tldr) || tldrUsable(state.tldr)) && sciSpaceMetaStillIncomplete(state, filename)) {
      await fillMetaFromRecordPage(page, state, filename);
    }
    if (descriptionUsable(filesTldr) || tldrUsable(filesTldr)) {
      state.tldr = stripTldrSnippetNumbers(filesTldr).slice(0, 2000);
    }

    log(
      `SciSpace メタ: title=${state.title.slice(0, 80)} doi=${state.doi || "(なし)"} tldr=${descriptionUsable(state.tldr) || tldrUsable(state.tldr) ? "あり" : "なし"} paste=${state.filesPaste.trim() ? "あり" : "なし"}`,
    );
    log(`SciSpace 個別ページ: ${state.scispaceUrl}`);
  } catch (e) {
    await saveFailureShot(page, paperDir, "scispace-meta");
    throw e;
  }
}

function sciSpaceMetaStillIncomplete(state: PaperState, filename: string): boolean {
  if (titleLooksLikeFilename(state.title, filename)) return true;
  if (!state.filesPaste.trim()) return true;
  if (!descriptionUsable(state.tldr) && !tldrUsable(state.tldr)) return true;
  return false;
}

function applyExtractedCard(
  state: PaperState,
  filename: string,
  card: ReturnType<typeof extractSciSpaceCardMeta>,
  dois: string[] = [],
): void {
  const filesTldrOpener =
    /^(The paper|This paper|The study|This study|本研究|本論文)\b/i;
  if (card.tldr && (tldrUsable(card.tldr) || descriptionUsable(card.tldr)) && filesTldrOpener.test(card.tldr)) {
    state.tldr = card.tldr;
  }
  if (card.title && !looksLikeSciSpaceNav(card.title) && !titleLooksLikeFilename(card.title, filename) && !looksLikeCitationTitle(card.title) && !looksLikeVenueLine(card.title)) {
    state.title = card.title;
  } else if (!state.title) state.title = filename.replace(/\.pdf$/i, "");
  if (card.venue && !looksLikeSciSpaceNav(card.venue)) state.venue = card.venue;
  const doi = card.doi || dois.map((d) => doiFromHrefOrText(d)).find(Boolean) || "";
  if (doi) state.doi = doi;
}

const READ_SCISPACE_ABSTRACT = `(() => {
  const label = /^(abstract|tl;\\s*dr|tldr|要旨|summary)$/i;
  const skip = /explain math|generate summary|chat with pdf|select a statement|read pdf in full screen/i;
  const nodes = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,p,div,section,article"));
  const found = [];
  for (let i = 0; i < nodes.length; i++) {
    const head = ((nodes[i].innerText || "")).trim().split("\\n")[0] || "";
    if (!label.test(head) || head.length > 24) continue;
    const buf = [];
    for (let j = i + 1; j < Math.min(i + 16, nodes.length); j++) {
      const n = ((nodes[j].innerText || "")).replace(/\\s+/g, " ").trim();
      if (!n || n.length < 60) {
        if (label.test(n) || /^(references|figures|pdf|introduction)$/i.test(n)) break;
        continue;
      }
      if (skip.test(n) || n.length > 4000) continue;
      if (label.test(n.split(" ")[0] || "")) break;
      buf.push(n);
      if (buf.join(" ").length > 500) break;
    }
    const t = buf.join(" ").trim();
    if (t.length >= 120) found.push(t);
  }
  found.sort((a, b) => b.length - a.length);
  return found[0] || "";
})()`;

async function readSciSpaceAbstractSection(page: Page): Promise<string> {
  const fromDom = String((await page.evaluate(READ_SCISPACE_ABSTRACT).catch(() => "")) || "").trim();
  if (tldrUsable(fromDom)) return fromDom.slice(0, 2000);
  const byRole = page.getByRole("heading", { name: /^(Abstract|TL;DR|要旨)$/i }).first();
  if (await byRole.isVisible({ timeout: 0 }).catch(() => false)) {
    const nearby = ((await byRole.locator("xpath=following::*[self::p or self::div][1]").innerText({ timeout: 4_000 }).catch(() => "")) || "").trim();
    if (tldrUsable(nearby)) return nearby.slice(0, 2000);
  }
  return "";
}

async function fillTldrFallbacks(
  page: Page,
  card: ReturnType<typeof extractSciSpaceCardMeta>,
  filename: string,
): Promise<void> {
  if (tldrUsable(card.tldr)) return;
  const section = await readSciSpaceAbstractSection(page);
  if (tldrUsable(section)) {
    log("SciSpace: 個別ページの Abstract / TL;DR を使います");
    card.tldr = section;
    return;
  }
  const arxivId = arxivIdFromFilename(filename);
  if (!arxivId) return;
  log(`SciSpace: arXiv の要旨を取ります (${arxivId})`);
  const abs = await fetchArxivAbstract(arxivId);
  if (tldrUsable(abs)) {
    log("SciSpace: arXiv の要旨を TL;DR に使います");
    card.tldr = abs.slice(0, 2000);
  }
}

async function fillMetaFromRecordPage(page: Page, state: PaperState, filename: string): Promise<void> {
  log("SciSpace: Files カードが薄いので個別ページからメタを取ります");
  await page.goto(state.scispaceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(2_500);
  const h1 = ((await page.locator("h1").first().innerText({ timeout: 8_000 }).catch(() => "")) || "").trim();
  const og = ((await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => "")) || "").trim();
  const ogDesc = (
    (await page.locator('meta[property="og:description"]').getAttribute("content").catch(() => "")) ||
    (await page.locator('meta[name="description"]').getAttribute("content").catch(() => "")) ||
    ""
  ).trim();
  const heading = [og, h1].find((t) => t.length > 12 && !looksLikeSciSpaceNav(t) && !looksLikeCitationTitle(t) && !looksLikeVenueLine(t) && !titleLooksLikeFilename(t, filename)) ?? "";
  const body = await pageText(page);
  const raw = [heading, ogDesc, body].filter(Boolean).join("\n");
  const card = extractSciSpaceCardMeta(raw, filename);
  if ((!card.title || titleLooksLikeFilename(card.title, filename) || looksLikeSciSpaceNav(card.title) || looksLikeCitationTitle(card.title) || looksLikeVenueLine(card.title)) && heading) {
    card.title = heading;
    card.paste = [heading, card.yearAuthorLine, card.venue].filter(Boolean).join("\n");
  }
  if ((!tldrUsable(card.tldr)) && tldrUsable(ogDesc)) {
    card.tldr = ogDesc.slice(0, 2000);
  }
  await fillTldrFallbacks(page, card, filename);
  applyExtractedCard(state, filename, card);
}

export async function captureSciSpaceRecordUrl(
  page: Page,
  opts: { folderUrl: string; filename: string; paperDir: string; state: PaperState },
): Promise<string> {
  const { folderUrl, filename, paperDir, state } = opts;
  if (isSciSpaceRecordUrl(state.scispaceUrl)) return state.scispaceUrl;
  try {
    await openNotebooksFilesView(page, folderUrl);
    await filterFilesList(page, folderUrl, filename);
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

/** Files に載ったあとカードメタが出るまでの猶予。NotebookLM 待ちのあいだに進む想定。 */
const SCISPACE_META_POLL_MS = 90_000;

async function collectUsableFilesCard(
  page: Page,
  folderUrl: string,
  filename: string,
  timeoutMs: number,
): Promise<FilesCardCandidates> {
  const start = Date.now();
  let last: FilesCardCandidates = { texts: [], dois: [] };
  let logged = false;
  while (Date.now() - start < timeoutMs) {
    await filterFilesList(page, folderUrl, filename);
    last = await collectFilesCardCandidates(page, filename);
    const filesPaste = pickBestSciSpaceCardText(last.texts, filename);
    const card = extractSciSpaceCardMeta(filesPaste, filename);
    if (usableSciSpacePaste(card, filename)) return last;
    if (!logged) {
      log("SciSpace: カードのメタが出るまで待ちます");
      logged = true;
    }
    await sleep(10_000);
  }
  return last;
}

export async function runSciSpaceUpload(
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
  if (isCompleted(state, "sci-upload")) return;
  try {
    log("SciSpace に PDF を先に載せます（メタは NotebookLM のあとで取ります）");
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
  } catch (e) {
    await saveFailureShot(page, paperDir, "scispace-upload");
    throw e;
  }
}

export async function runSciSpaceMeta(
  page: Page,
  opts: {
    folderUrl: string;
    filename: string;
    paperDir: string;
    state: PaperState;
  },
): Promise<void> {
  const { folderUrl, filename, paperDir, state } = opts;
  const pasteOk = Boolean(rawFilesCardPaste(state.filesPaste, filename));
  if (isCompleted(state, "sci-meta") && isSciSpaceRecordUrl(state.scispaceUrl) && pasteOk) {
    return;
  }
  log("SciSpace メタを集めます");
  await captureSciSpaceCardMeta(page, { folderUrl, filename, paperDir, state });
  if (!isSciSpaceRecordUrl(state.scispaceUrl)) {
    await captureSciSpaceRecordUrl(page, { folderUrl, filename, paperDir, state });
  }
  if (!isSciSpaceRecordUrl(state.scispaceUrl)) {
    throw new Error(`SciSpace の個別ページ URL が見つかりません（${filename}）`);
  }
  if (!rawFilesCardPaste(state.filesPaste, filename)) {
    throw new Error(`SciSpace Files 列のメタが取れません（${filename}）`);
  }
  markCompleted(state, "sci-meta");
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
  await runSciSpaceUpload(page, { folderUrl, pdfPath, filename, paperDir, state });
  await runSciSpaceMeta(page, { folderUrl, filename, paperDir, state });
}
