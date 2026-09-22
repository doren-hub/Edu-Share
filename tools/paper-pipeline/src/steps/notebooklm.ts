import { copyFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { pauseIfBlocked, isInteractiveUi } from "../human.ts";
import { log, warn } from "../log.ts";
import { isTargetClosedError } from "../browser.ts";
import {
  firstPendingStudioStage,
  hasStudioStarted,
  isCompleted,
  markCompleted,
  markStudioStarted,
  requiredStudioStages,
  saveState,
  studioKickoffSettled,
  unmarkStudioStarted,
  waitingStudioStage,
  type PaperState,
  type StageId,
  type StudioStageId,
} from "../state.ts";
import {
  clickFirstByName,
  saveFailureShot,
  waitForAnyVisible,
  waitForDownloadTo,
} from "../ui.ts";
import {
  STUDIO_RELATIVE_TIME,
  formatVideoScan,
  isChatCustomizeLabel,
  isStudioGenerateLabel,
  scanStudioVideoOutputs,
  shouldKickoffSlides,
  shouldKickoffVideo,
  studioOutputScanIncomplete,
  studioVideoGenerationDone,
  isSlideDeckCardText,
  isPresenterSlideFormatText,
  textLooksLikeGenerating,
  type VideoKickoffScan,
} from "../studio-cards.ts";
import { GenerationWaitingError } from "../waiting.ts";
import {
  loadNotebookQuota,
  notebookGenerationPause,
  NotebookQuotaPauseError,
  type NotebookQuotaConfig,
} from "../notebook-quota.ts";
import { VIDEO_MIN_BYTES, isMp4FtypBuffer, isRealVideoFile, rankVideoArtifactUrls, videoFileReady } from "../video-file.ts";
import { formatStudioGenerateJa } from "../studio-select.ts";

const NOTEBOOK_APP_HOST = /(?:notebooklm|notebook)\.google\.com/i;
/** /notebook/creating は作成中の仮 URL。UUID 付きだけをノート本体とみなす */
const NOTEBOOK_DOC_PATH =
  /(?:notebooklm|notebook)\.google\.com\/notebook\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function artifactReady(path: string, minBytes: number): boolean {
  try {
    if (!existsSync(path) || statSync(path).size <= minBytes) return false;
    if (/\.mp4$/i.test(path)) return isRealVideoFile(path);
    return true;
  } catch {
    return false;
  }
}

/** Chrome の printToPDF でノート画面を焼いた PDF（1枚の UI キャプチャ） */
export function looksLikeNotebookUiPdf(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 160_000)).toString("latin1");
  return /Gemini Notebook|ノートブックを作成|ソースを追加|ウェブで新しいソース/.test(head);
}

function isRealSlidePdf(buf: Buffer): boolean {
  if (buf.length < 80_000) return false;
  if (buf.subarray(0, 5).toString("utf8") !== "%PDF-") return false;
  if (looksLikeNotebookUiPdf(buf)) return false;
  return true;
}

function slidesArtifactReady(path: string): boolean {
  if (!artifactReady(path, 80_000)) return false;
  try {
    return isRealSlidePdf(readFileSync(path));
  } catch {
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function isNotebookAppUrl(url: string): boolean {
  return NOTEBOOK_APP_HOST.test(url);
}

function isNotebookDocumentUrl(url: string): boolean {
  return NOTEBOOK_DOC_PATH.test(url);
}

function canonicalNotebookUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url.split(/[?#]/)[0];
  }
}

function forgetUnstableNotebook(state: PaperState): void {
  if (state.notebooklmUrl) {
    const cleaned = canonicalNotebookUrl(state.notebooklmUrl);
    if (cleaned !== state.notebooklmUrl) {
      state.notebooklmUrl = cleaned;
      saveState(state);
    }
  }
  if (isNotebookDocumentUrl(state.notebooklmUrl)) return;
  if (!state.notebooklmUrl && !state.completed.includes("nlm-create")) return;
  warn(
    `ノート URL が未確定のため作成からやり直します: ${state.notebooklmUrl || "(空)"}`,
  );
  state.notebooklmUrl = "";
  state.completed = state.completed.filter((s) => s !== "nlm-create");
  saveState(state);
}

async function notebookBody(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 8_000 }).catch(() => "");
}

async function isVisibleNow(loc: Locator): Promise<boolean> {
  return loc.first().isVisible({ timeout: 0 }).catch(() => false);
}

async function innerTextNow(loc: Locator, timeoutMs = 3_000): Promise<string> {
  return loc.first().innerText({ timeout: timeoutMs }).catch(() => "");
}

async function attrNow(loc: Locator, name: string): Promise<string> {
  return (await loc.first().getAttribute(name, { timeout: 0 }).catch(() => "")) ?? "";
}

function textHasSourceProcessing(t: string): boolean {
  return /取り込み中|処理中|読み込んでいます|Uploading|Processing source|ソースを処理/i.test(t);
}

const SOURCE_ADD_UI =
  /ソースを追加|Add source|パソコンから|From computer|ファイルをアップロード|Upload file|Google Drive|Choose file|コピーしたテキスト|Copied text/;

async function sourceAddUiVisible(page: Page): Promise<boolean> {
  const dlg = page.getByRole("dialog").or(page.locator('[role="dialog"], [aria-modal="true"]'));
  if (!(await isVisibleNow(dlg))) return false;
  const t = (await innerTextNow(dlg)).trim();
  return SOURCE_ADD_UI.test(t);
}

function pdfFileNames(pdfPath: string): { name: string; stem: string } {
  const name = pdfPath.split(/[/\\]/).pop() ?? "";
  return { name, stem: name.replace(/\.pdf$/i, "") };
}

function textHasPdfName(t: string, pdfPath: string): boolean {
  const { name, stem } = pdfFileNames(pdfPath);
  return Boolean((name && t.includes(name)) || (stem.length > 4 && t.includes(stem)));
}

function textHasZeroSources(t: string): boolean {
  return /0\s*個のソース|0\s*件のソース|0 sources/i.test(t);
}

function textHasEmptySourceList(t: string): boolean {
  return /保存したソースがここに表示されます|ファイルやウェブサイトなどを追加/.test(t);
}

function textHasReadySources(t: string): boolean {
  if (textHasZeroSources(t) || textHasEmptySourceList(t)) return false;
  return /[1-9]\d*\s*件のソース|[1-9]\d*\s*個のソース|[1-9]\d*\s*sources/i.test(t);
}

async function expandNotebookPanels(page: Page): Promise<void> {
  await dismissSourceDeleteMenu(page);
  const t = await notebookBody(page);
  if (textHasReadySources(t) && !textHasZeroSources(t)) {
    if (!(await isVisibleNow(page.getByText("スライド資料", { exact: false })))) {
      await clickFirstByName(page, [/^Studio$/i, /スタジオ/], { timeoutMs: 4_000 });
      await page.waitForTimeout(400);
    }
  }
  await openSourcesPanel(page);
}

async function openSourcesPanel(page: Page): Promise<void> {
  if (await page.getByText("ソースを追加", { exact: false }).first().isVisible({ timeout: 0 }).catch(() => false)) {
    return;
  }
  await clickFirstByName(page, [/ソースを追加/, /^ソース$/, /Sources/i], { timeoutMs: 4_000 });
  await page.waitForTimeout(400);
}

async function waitUntilNotebookIdle(page: Page, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await notebookBody(page);
    if (!/Loading Notebook/i.test(t) && isNotebookDocumentUrl(page.url())) return;
    await page.waitForTimeout(500);
  }
}

async function ensureOnNotebook(page: Page, url: string): Promise<void> {
  const want = canonicalNotebookUrl(url);
  const here = canonicalNotebookUrl(page.url());
  if (!want || here !== want || /addSource=/i.test(page.url())) {
    log(`既存ノートを開きます: ${want}`);
    await page.goto(want, { waitUntil: "domcontentloaded", timeout: 60_000 });
    log(`ノートを開きました: ${page.url()}`);
    await pauseIfBlocked(page, "NotebookLM");
  }
  await dismissNotebookLmPopups(page);
  log("お知らせ確認を終えました");
  await waitUntilNotebookIdle(page);
  await expandNotebookPanels(page);
  log("ノートのソース / Studio パネルを確認しました");
}

async function forgetMissingSource(page: Page, state: PaperState, pdfPath: string): Promise<void> {
  if (!isCompleted(state, "nlm-upload")) return;
  if (
    hasStudioStarted(state, "nlm-video") ||
    isCompleted(state, "nlm-slides") ||
    isCompleted(state, "nlm-quiz") ||
    isCompleted(state, "nlm-flashcards")
  ) {
    return;
  }
  await dismissNotebookLmPopups(page);
  await expandNotebookPanels(page);
  const t = await notebookBody(page);
  if (textHasReadySources(t) && (textHasPdfName(t, pdfPath) || !textHasEmptySourceList(t))) return;
  warn("ソース PDF が見つからないためアップロードからやり直します");
  state.completed = state.completed.filter((s) => s === "nlm-create");
  saveState(state);
}

const SOURCE_READY_MS = 8 * 60_000;
const SLIDE_MS = 20 * 60_000;
const VIDEO_MS = 90 * 60_000;
const STUDIO_START_STALL_MS = 40_000;
const QUIZ_MS = 8 * 60_000;
/** 生成中を確認してから Chrome を明け渡すまでの猶予（すぐ終わる生成はここで完了させる） */
const YIELD_AFTER_GENERATING_MS = 12_000;

const ANNOUNCEMENT_TEXT =
  /Gemini Notebook の使用方法|上限は 5 時間|バックグラウンド キュー|What's new|新機能/;

async function studioCustomizeVisible(page: Page): Promise<boolean> {
  const dialog = page.getByRole("dialog");
  if (!(await isVisibleNow(dialog))) return false;
  const t = await innerTextNow(dialog);
  return /後で生成|質問の数|をカスタマイズ|難易度レベル|希望するトピック|Generate later/i.test(t);
}

async function dismissPointerBlockers(page: Page): Promise<void> {
  await dismissSourceDeleteMenu(page);
  await dismissStudioCustomize(page);
  await page.keyboard.press("Escape").catch(() => undefined);
  const backdrop = page.locator(".cdk-overlay-backdrop-showing, .cdk-overlay-backdrop").first();
  if (await isVisibleNow(backdrop)) {
    await backdrop.click({ force: true, timeout: 1_000 }).catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  await page.waitForTimeout(200);
}

async function dismissStudioCustomize(page: Page): Promise<void> {
  if (!(await studioCustomizeVisible(page))) return;
  log("Studio のカスタマイズ画面を閉じます（後で生成は押しません）");
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: /閉じる|Close/i });
  if (await isVisibleNow(close)) {
    await close.first().click({ timeout: 3_000 }).catch(() => undefined);
  } else {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  await page.waitForTimeout(400);
}

async function announcementVisible(page: Page): Promise<boolean> {
  if (await studioCustomizeVisible(page)) return false;
  if (await sourceAddUiVisible(page)) return false;
  const dlg = page.getByRole("dialog").or(page.locator('[role="dialog"], [aria-modal="true"]'));
  if (!(await isVisibleNow(dlg))) return false;
  const t = (await innerTextNow(dlg)).trim();
  return /Gemini Notebook の使用方法|上限は 5 時間|バックグラウンド キュー|What's new/i.test(t);
}

/** What's new / 利用上限のお知らせなど、ホーム操作を塞ぐモーダルを閉じる */
async function dismissNotebookLmPopups(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if (await studioCustomizeVisible(page)) return;
    if (await sourceAddUiVisible(page)) return;
    if (!(await announcementVisible(page))) return;

    const dialog = page.getByRole("dialog").or(page.locator('[role="dialog"], [aria-modal="true"]'));
    const namedClose = dialog.getByRole("button", { name: /閉じる|Close|Dismiss/i });
    const labeled = page.locator(
      '[aria-label="閉じる"], [aria-label="Close"], [aria-label="Dismiss"], [aria-label="close"]',
    );

    let clicked = false;
    if (await isVisibleNow(namedClose)) {
      await namedClose.first().click({ force: true, timeout: 3000 }).catch(() => undefined);
      clicked = true;
    } else if (await isVisibleNow(labeled)) {
      await labeled.first().click({ force: true, timeout: 3000 }).catch(() => undefined);
      clicked = true;
    } else {
      const xMark = dialog.getByRole("button", { name: /^×$|^✕$|^x$/i });
      if (await isVisibleNow(xMark)) {
        await xMark.first().click({ force: true, timeout: 3000 }).catch(() => undefined);
        clicked = true;
      } else {
        const n = await dialog.getByRole("button").count().catch(() => 0);
        if (n > 0) {
          // 先頭は「試してみる / 後で生成」などの CTA になりやすいので押さない
          await dialog
            .getByRole("button")
            .nth(n - 1)
            .click({ force: true, timeout: 3000 })
            .catch(() => undefined);
          clicked = true;
        } else {
          const box = await dialog.first().boundingBox().catch(() => null);
          if (box) {
            await page.mouse.click(box.x + box.width - 28, box.y + 28);
            clicked = true;
          }
        }
      }
    }

    if (!clicked) {
      const heading = page.getByText(ANNOUNCEMENT_TEXT).first();
      if (await isVisibleNow(heading)) {
        const box = await heading
          .evaluate((el) => {
            let n: HTMLElement | null = el as HTMLElement;
            while (n && n !== document.body) {
              const st = getComputedStyle(n);
              const role = n.getAttribute("role");
              if (
                role === "dialog" ||
                n.getAttribute("aria-modal") === "true" ||
                st.position === "fixed"
              ) {
                const r = n.getBoundingClientRect();
                if (r.width > 200 && r.height > 120) {
                  return { x: r.x, y: r.y, w: r.width, h: r.height };
                }
              }
              n = n.parentElement;
            }
            const r = (el as HTMLElement).getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          })
          .catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.w - 28, box.y + 28);
        }
      }
    }

    if (!(await sourceAddUiVisible(page))) {
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    await page.waitForTimeout(500);
    if (!(await announcementVisible(page))) {
      log("NotebookLM のお知らせダイアログを閉じました");
      return;
    }
  }
  if (await sourceAddUiVisible(page)) return;
  warn("お知らせダイアログが残っている可能性があります（Escape は送りません）");
}

async function ensureNotebookLmHome(page: Page, homeUrl: string): Promise<void> {
  await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
  await pauseIfBlocked(page, "NotebookLM");
  if (/accounts\.google\.com|signin\.google/i.test(page.url())) {
    throw new Error("NotebookLM のログインが完了していません（待ち中に画面は触りません）");
  }
  if (!isNotebookAppUrl(page.url())) {
    await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
  }
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  await dismissNotebookLmPopups(page);
}

const CREATE_NOTEBOOK_NAME =
  /ノートブックを新規作成|ノートブックを作成|新しいノートブック|新規ノートブック|ノートを作成|Create new notebook|New notebook/i;

function createNotebookLocators(page: Page) {
  return [
    page.getByRole("button", { name: CREATE_NOTEBOOK_NAME }),
    page.getByRole("link", { name: CREATE_NOTEBOOK_NAME }),
    page.getByLabel(CREATE_NOTEBOOK_NAME),
    page.getByText("ノートブックを新規作成", { exact: false }),
    page.getByText("新しいノートブック", { exact: false }),
    page.getByText("ノートブックを作成", { exact: false }),
    page.getByText("Create new notebook", { exact: false }),
    page.getByText("New notebook", { exact: false }),
    page.locator("button, [role='button'], a").filter({
      hasText: /ノートブックを新規作成|ノートブックを作成|New notebook|Create new notebook/i,
    }),
  ];
}

async function createNotebook(page: Page, homeUrl: string): Promise<string> {
  await ensureNotebookLmHome(page, homeUrl);
  await dismissNotebookLmPopups(page);
  const loc = await waitForAnyVisible(page, createNotebookLocators(page), 30_000);
  if (!loc) {
    throw new Error(
      "NotebookLM の新規ノート作成ボタンが見つかりません（「ノートブックを新規作成」等）。failures のスクリーンショットと *-dom.json を確認してください。",
    );
  }
  await loc.click();
  await page.waitForURL(NOTEBOOK_DOC_PATH, { timeout: 90_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  await dismissNotebookLmPopups(page);
  const url = page.url();
  if (!isNotebookDocumentUrl(url)) {
    throw new Error(
      `ノート作成後の URL が想定外です: ${url}（/notebook/creating ではなく UUID のノート画面まで待ちます）`,
    );
  }
  const ready = await waitForAnyVisible(
    page,
    [
      page.getByRole("button", { name: /ソースを追加|Add source/i }),
      page.getByText(/ソースを追加|Add source/i),
      page.getByRole("button", { name: /^Studio$/i }),
      page.getByText(/^Studio$/),
    ],
    45_000,
  );
  if (!ready) {
    warn("ノート URL は確定しましたが、ソース追加 / Studio が見えません");
  }
  const settled = page.url();
  log(`NotebookLM ノート: ${settled}`);
  return settled;
}

async function setVisiblePdfInput(page: Page, pdfPath: string): Promise<boolean> {
  const dialog = page.getByRole("dialog");
  if (await dialog.first().isVisible({ timeout: 0 }).catch(() => false)) {
    const inDlg = dialog.locator('input[type="file"]');
    if ((await inDlg.count()) > 0) {
      await inDlg.first().setInputFiles(pdfPath);
      return true;
    }
  }
  const inputs = page.locator('input[type="file"]');
  if ((await inputs.count()) > 0) {
    await inputs.first().setInputFiles(pdfPath);
    return true;
  }
  return false;
}

async function confirmSourceInsert(page: Page): Promise<void> {
  const names = [/挿入/, /^Insert$/i, /ソースを挿入/, /追加する/, /^Add$/i, /アップロード$/, /^Upload$/i];
  for (const name of names) {
    const btn = page.getByRole("button", { name });
    if (await btn.first().isVisible({ timeout: 0 }).catch(() => false)) {
      await btn.first().click({ timeout: 5_000 }).catch(() => undefined);
      log("ソース追加の確定ボタンをクリックしました");
      return;
    }
  }
}

async function attachPdfAsSource(page: Page, pdfPath: string): Promise<void> {
  await openSourcesPanel(page);
  if (await sourceAddUiVisible(page)) {
    log("ソース追加ダイアログは既に開いています");
  } else {
    const addClicked = await clickFirstByName(page, [/^\+?\s*ソースを追加$/, /ソースを追加/, /Add source/i]);
    if (!addClicked) warn("「ソースを追加」をクリックできませんでした");
    await page.waitForTimeout(800);
  }

  if (await setVisiblePdfInput(page, pdfPath)) {
    log("file input で PDF をセットしました");
  } else {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 15_000 }).catch(() => null);
    await clickFirstByName(
      page,
      [
        /パソコンから/,
        /コンピュータ/,
        /From computer/i,
        /デバイス/,
        /ファイルをアップロード/,
        /Upload file/i,
        /Choose file/i,
        /ファイルを選択/,
        /^PDF$/,
      ],
      { timeoutMs: 8_000 },
    );
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(pdfPath);
      log("file chooser で PDF をセットしました");
    } else {
      throw new Error(
        "ソース追加の file chooser / input が見つかりませんでした（「+ ソースを追加」→ パソコンから）",
      );
    }
  }
  await page.waitForTimeout(800);
  await confirmSourceInsert(page);
  await page.waitForTimeout(400);
  await confirmSourceInsert(page);
}

async function uploadPdfToNotebook(page: Page, pdfPath: string): Promise<void> {
  await dismissNotebookLmPopups(page);
  await openSourcesPanel(page);
  const t0 = await notebookBody(page);
  if (textHasReadySources(t0) && !textHasZeroSources(t0)) {
    log("NotebookLM にソース PDF が既にあります");
    return;
  }
  if (textHasZeroSources(t0) || textHasEmptySourceList(t0)) log("ソース 0 件のため追加します");

  await attachPdfAsSource(page, pdfPath);

  log("NotebookLM に PDF を渡しました。取り込み待ち…");
  const start = Date.now();
  const minReadyAt = Date.now() + 8_000;
  let lastHint = "件数未確認";
  let lastLog = 0;
  let retried = false;
  while (Date.now() - start < SOURCE_READY_MS) {
    if (await sourceAddUiVisible(page)) {
      lastHint = "ソース追加ダイアログが残っている";
      await confirmSourceInsert(page);
      await page.waitForTimeout(1000);
      continue;
    }
    const t = await notebookBody(page);
    if (/Loading Notebook/i.test(t)) {
      lastHint = "ノート読み込み中";
      await page.waitForTimeout(1000);
      continue;
    }
    if (/取り込みに失敗|failed to add source/i.test(t)) {
      throw new Error("NotebookLM のソース取り込みに失敗しました");
    }
    const named = textHasPdfName(t, pdfPath);
    const zero = textHasZeroSources(t);
    const empty = textHasEmptySourceList(t);
    const counted = textHasReadySources(t);
    const processing = textHasSourceProcessing(t);
    if (counted && !zero && !empty && Date.now() >= minReadyAt) {
      log(`ソース取り込み完了（${named ? "PDF 名と" : ""}件数を確認）`);
      return;
    }
    lastHint = processing
      ? "取り込み中"
      : zero || empty
        ? "まだ 0 個のソース"
        : counted
          ? "件数はあるが待機中"
          : named
            ? "ファイル名はあるが件数未確認（ダイアログの名前の可能性）"
            : "PDF 名未検出";
    const elapsed = Date.now() - start;
    if (elapsed - lastLog >= 15_000) {
      log(`ソース取り込み待ち ${Math.round(elapsed / 1000)}秒: ${lastHint}`);
      lastLog = elapsed;
    }
    if (!retried && !processing && (zero || empty) && elapsed > 25_000) {
      warn("ソースが 0 のままなので追加をもう一度試します");
      retried = true;
      await attachPdfAsSource(page, pdfPath);
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(`NotebookLM のソース取り込みがタイムアウトしました（${lastHint}）`);
}

async function studioArtifactViewerOpen(page: Page): Promise<boolean> {
  const t = await notebookBody(page);
  if (/をカスタマイズ|後で生成|Generate later/i.test(t)) return false;
  if (/個のソースを表示/.test(t) && /チャットパネル|collapse_content|expand_content/.test(t)) {
    return true;
  }
  return false;
}

/** スライド/動画の全画面ビューアが Studio タイルを隠すので閉じる */
async function dismissStudioViewer(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (!(await studioArtifactViewerOpen(page))) return;
    log("Studio の成果物ビューアを閉じます");
    const hit = await clickFirstByName(
      page,
      [/^閉じる$/, /^Close$/i, /collapse_content/, /arrow_back/, /戻る/],
      { timeoutMs: 2_000 },
    );
    if (!hit) await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(600);
  }
}

async function openStudio(page: Page): Promise<void> {
  await dismissStudioViewer(page);
  const slide = page.getByText("スライド資料", { exact: false });
  if (await isVisibleNow(slide) && !(await studioArtifactViewerOpen(page))) return;
  await clickFirstByName(page, [/Studio/i, /スタジオ/]);
  await page.waitForTimeout(800);
}

async function studioOutputCount(page: Page): Promise<number> {
  return page.getByText(STUDIO_RELATIVE_TIME).count().catch(() => 0);
}

async function clickStudioShowMore(page: Page): Promise<void> {
  const buttons = page.getByRole("button", { name: /もっと見る|Show more|See more/i });
  const n = Math.min(await buttons.count().catch(() => 0), 6);
  for (let i = 0; i < n; i++) {
    const btn = buttons.nth(i);
    if (!(await isVisibleNow(btn))) continue;
    const box = await btn.boundingBox().catch(() => null);
    if (!box || box.x < 720) continue;
    await btn.click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(350);
  }
}

async function revealStudioOutputs(page: Page): Promise<void> {
  await dismissSourceDeleteMenu(page);
  await page.getByText(/^Studio$/).first().scrollIntoViewIfNeeded().catch(() => undefined);
  await page
    .evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll("h2, h3, div, span"));
      const header = nodes.find((el) => ((el.innerText || "").trim() === "Studio");
      let p = header;
      for (let i = 0; i < 10 && p; i++) {
        if (p.scrollHeight > p.clientHeight + 80) {
          p.scrollTop = p.scrollHeight;
          return true;
        }
        p = p.parentElement;
      }
      return false;
    })()`)
    .catch(() => false);
  await clickStudioShowMore(page);
  const duration = page.getByText(/\b\d{1,2}:\d{2}\s*·\s*解説/).first();
  if (await duration.isVisible({ timeout: 0 }).catch(() => false)) {
    await duration.scrollIntoViewIfNeeded().catch(() => undefined);
  }
  await page.waitForTimeout(200);
}

async function waitUntilStudioOutputsReady(page: Page, timeoutMs = 45_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) return false;
    await revealStudioOutputs(page);
    const t = await notebookBody(page).catch(() => "");
    if (!studioOutputScanIncomplete(t)) return true;
    await page.waitForTimeout(500).catch(() => undefined);
  }
  warn("Studio 出力カードがまだ出ていません（ツールバーだけのときは開始記録を消しません）");
  return false;
}

async function logStudioCardSummaries(page: Page): Promise<void> {
  await revealStudioOutputs(page);
  const rows = await studioCardTexts(page);
  const scan = scanStudioVideoOutputs([...rows, await notebookBody(page)]);
  log(`Studio 出力カード: ${rows.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 80)).join(" || ") || "(なし)"}`);
  log(`Studio ${formatVideoScan(scan)}`);
}

async function studioHasSlideDeckOutput(page: Page): Promise<boolean> {
  await expandNotebookPanels(page);
  await dismissStudioCustomize(page);
  await revealStudioOutputs(page);
  await page.waitForTimeout(1200);
  const body = await notebookBody(page);
  const studioAt = body.search(/Studio/);
  const snippet = body.replace(/\s+/g, " ").slice(Math.max(0, studioAt), Math.max(0, studioAt) + 500);
  log(`Studio付近: ${snippet.slice(0, 400)}`);
  if (/Illuminated Horizons/.test(body)) {
    log("本文に既存スライド（Illuminated Horizons）があります");
    return true;
  }
  const stamps = page.getByText(STUDIO_RELATIVE_TIME);
  const n = await stamps.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const card = stamps.nth(i).locator("xpath=ancestor::*[.//button][1]");
    const text = await card.innerText({ timeout: 2_000 }).catch(() => "");
    if (isSlideDeckCardText(text)) return true;
  }
  return false;
}

async function openStudioCardMatching(page: Page, re: RegExp): Promise<boolean> {
  await expandNotebookPanels(page);
  await dismissPointerBlockers(page);
  const stamps = page.getByText(STUDIO_RELATIVE_TIME);
  const n = await stamps.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const stamp = stamps.nth(i);
    const card = stamp.locator("xpath=ancestor::*[.//button][1]");
    const text = await card.innerText().catch(() => "");
    if (!re.test(text)) continue;
    const clicked = await stamp
      .click({ timeout: 3_000, force: true })
      .then(() => true)
      .catch(async () => card.click({ timeout: 3_000, force: true }).then(() => true).catch(() => false));
    if (!clicked) continue;
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

async function waitForStudioOutputs(page: Page, timeoutMs = 10_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await expandNotebookPanels(page);
    const n = await studioOutputCount(page);
    if (n > 0) return n;
    await page.waitForTimeout(500);
  }
  return 0;
}

async function openLatestStudioOutput(page: Page): Promise<boolean> {
  const time = page.getByText(STUDIO_RELATIVE_TIME);
  if (!(await time.first().isVisible({ timeout: 0 }).catch(() => false))) return false;
  await time.first().click({ timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  return true;
}

async function logVisibleButtonNames(page: Page): Promise<void> {
  try {
    const names = (await page.evaluate(`(() => {
      const out = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll("button, [role='button']")) {
          const t = ((el.innerText || el.getAttribute("aria-label") || "")).replace(/\\s+/g, " ").trim();
          if (t) out.push(t.slice(0, 80));
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      return out.slice(0, 80);
    })()`)) as string[];
    log(`見えるボタン: ${names.join(" | ") || "(なし)"}`);
  } catch (e) {
    warn(`ボタン一覧を取れません: ${e instanceof Error ? e.message : e}`);
  }
}

async function clickFailedStudioRetry(page: Page): Promise<boolean> {
  const retry = page.getByRole("button", { name: /再試行|Retry/i });
  if (await retry.first().isVisible({ timeout: 0 }).catch(() => false)) {
    log("Studio: 失敗した生成の再試行をクリックします");
    await retry.first().click({ timeout: 8_000 });
    await page.waitForTimeout(1000);
    return true;
  }
  return clickFirstByName(page, [/^再試行$/, /^Retry$/i], { timeoutMs: 3_000 });
}

function textLooksLikeStudioFailure(t: string): boolean {
  return /再試行/.test(t) && /削除/.test(t);
}

/** 生成ボタンを押してから UI に sync が出るまでの猶予。ここを過ぎても出力が無ければやり直し。 */
const GENERATION_START_GRACE_MS = 20 * 60 * 1000;

function generationStartIsRecent(state: PaperState): boolean {
  const t = Date.parse(state.generationStartedAt || "");
  if (!Number.isFinite(t) || t <= 0) return false;
  const age = Date.now() - t;
  return age >= 0 && age < GENERATION_START_GRACE_MS;
}

async function studioHasCardMatching(page: Page, re: RegExp): Promise<boolean> {
  await expandNotebookPanels(page);
  const stamps = page.getByText(STUDIO_RELATIVE_TIME);
  const n = await stamps.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const card = stamps.nth(i).locator("xpath=ancestor::*[.//button][1]");
    const text = await card.innerText({ timeout: 2_000 }).catch(() => "");
    if (re.test(text)) return true;
  }
  return false;
}

async function clickStudioGenerate(page: Page): Promise<boolean> {
  const skipLater = /後で|later|スケジュール|Generate later/i;
  const preferNow = /今すぐ|Generate now/i;

  const nowHit = await clickFirstByName(
    page,
    [/今すぐ生成/, /Generate now/i, /^今すぐ$/],
    { timeoutMs: 3_000 },
  );
  if (nowHit) return true;

  const overlay = page.locator("[role='dialog'], .cdk-overlay-pane, [aria-modal='true']");
  const overlayOpen = await overlay.first().isVisible().catch(() => false);
  if (!overlayOpen) {
    const customizeBtns = page.getByRole("button", { name: /カスタマイズ|Customize/i });
    const n = Math.min(await customizeBtns.count().catch(() => 0), 12);
    for (let i = 0; i < n; i++) {
      const btn = customizeBtns.nth(i);
      if (!(await isVisibleNow(btn))) continue;
      const text = `${await innerTextNow(btn, 0)} ${await attrNow(btn, "aria-label")}`;
      if (isChatCustomizeLabel(text)) continue;
      log("Studio: カスタマイズを開いてから生成します");
      await btn.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      break;
    }
  }

  const dialog = page.getByRole("dialog").or(page.locator(".cdk-overlay-pane"));
  if (await dialog.first().isVisible().catch(() => false)) {
    await dialog
      .first()
      .evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      })
      .catch(() => undefined);
  }
  await page.keyboard.press("End").catch(() => undefined);
  await page.waitForTimeout(400);

  const roots = [
    ...(await dialog.first().isVisible().catch(() => false) ? [dialog.first()] : []),
    page.locator("body"),
  ];
  const candidates: { btn: ReturnType<Page["locator"]>; now: boolean }[] = [];
  for (const root of roots) {
    const btns = root.getByRole("button").filter({ hasText: /生成|Generate/i });
    const n = await btns.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const b = btns.nth(i);
      const text = `${(await b.innerText({ timeout: 0 }).catch(() => "")).replace(/\s+/g, " ")} ${
        await attrNow(b, "aria-label")
      }`;
      if (!isStudioGenerateLabel(text) && skipLater.test(text)) continue;
      if (/ノートブックを作成/.test(text) || skipLater.test(text) || isChatCustomizeLabel(text)) continue;
      if (!/生成|Generate|作成/i.test(text)) continue;
      candidates.push({ btn: b, now: preferNow.test(text) });
    }
  }
  candidates.sort((a, b) => Number(b.now) - Number(a.now));
  for (const { btn } of candidates) {
    if (!(await btn.isVisible().catch(() => false))) {
      await btn.scrollIntoViewIfNeeded().catch(() => undefined);
    }
    if (!(await btn.isEnabled().catch(() => false))) continue;
    const text = `${await innerTextNow(btn, 0)} ${await attrNow(btn, "aria-label")}`;
    if (isChatCustomizeLabel(text) || /ノートブックを作成/.test(text)) continue;
    await btn.click({ timeout: 5_000, force: true }).catch(() => undefined);
    return true;
  }
  return clickFirstByName(
    page,
    [/^生成$/, /^作成$/, /今すぐ生成/, /Generate now/i, /動画を生成/, /スライド.*生成/],
    { timeoutMs: 4_000 },
  );
}

async function clickStudioTile(page: Page, labels: (string | RegExp)[]): Promise<boolean> {
  await openStudio(page);
  await page.getByText(/^Studio$/).first().scrollIntoViewIfNeeded().catch(() => undefined);
  if (await clickFirstByName(page, labels, { timeoutMs: 4_000 })) {
    log(`Studio: タイルをクリックしました（${String(labels[0])}）`);
    return true;
  }
  for (const label of labels) {
    const re = typeof label === "string" ? new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : label;
    const tiles = page.locator("button, [role='button'], a").filter({ hasText: re });
    const n = Math.min(await tiles.count().catch(() => 0), 20);
    for (let i = n - 1; i >= 0; i--) {
      const t = tiles.nth(i);
      if (!(await t.isVisible({ timeout: 0 }).catch(() => false))) continue;
      await t.scrollIntoViewIfNeeded().catch(() => undefined);
      await t.click({ force: true, timeout: 5_000 });
      log(`Studio: テキスト一致でタイルをクリックしました（${String(label)}）`);
      return true;
    }
    const texts = page.getByText(re);
    const m = Math.min(await texts.count().catch(() => 0), 20);
    for (let i = 0; i < m; i++) {
      const el = texts.nth(i);
      if (!(await el.isVisible({ timeout: 0 }).catch(() => false))) continue;
      await el.scrollIntoViewIfNeeded().catch(() => undefined);
      await el.click({ force: true, timeout: 5_000 }).catch(() => undefined);
      log(`Studio: 見出しをクリックしました（${String(label)}）`);
      return true;
    }
  }
  return false;
}

const SHORT_VIDEO_FORMAT = /ショート|Short\b|Brief|シネマティック|Cinematic/i;

async function selectExplainerVideoFormat(page: Page): Promise<void> {
  log("動画形式: 説明 / 解説 を探します");
  const dialog = page.getByRole("dialog");
  if (!(await isVisibleNow(dialog))) {
    warn("動画形式: カスタマイズダイアログが無いので形式選択を飛ばします");
    return;
  }
  const root = dialog.first();
  const groups = [
    root.getByRole("radio"),
    root.getByRole("tab"),
    root.getByRole("button"),
    root.locator("[role='option']"),
  ];
  for (const group of groups) {
    const n = Math.min(await group.count().catch(() => 0), 40);
    for (let i = 0; i < n; i++) {
      const el = group.nth(i);
      if (!(await isVisibleNow(el))) continue;
      const text = `${await innerTextNow(el, 0)} ${await attrNow(el, "aria-label")}`
        .replace(/\s+/g, " ")
        .trim();
      if (SHORT_VIDEO_FORMAT.test(text)) continue;
      const explainer =
        /説明動画|Explainer|解説動画/i.test(text) || text === "説明" || text === "解説";
      if (!explainer) continue;
      await el.click({ timeout: 5_000 });
      log(`動画形式: 説明動画を選びました（${text.slice(0, 40)}）`);
      await page.waitForTimeout(500);
      return;
    }
  }
  const clicked = await clickFirstByName(
    page,
    [/説明動画/, /^説明$/, /Explainer/i, /^解説$/, /解説動画/],
    { timeoutMs: 4_000 },
  );
  if (clicked) log("動画形式: 説明 / 解説 をクリックしました");
  else warn("説明動画の形式ボタンが見つかりません。ショートが選ばれたままの可能性があります");
}

async function studioCustomizeRoot(page: Page): Promise<Locator | null> {
  const dialog = page.getByRole("dialog");
  const overlay = page.locator(".cdk-overlay-pane");
  if (await isVisibleNow(dialog)) return dialog.first();
  if (await isVisibleNow(overlay)) return overlay.last();
  return null;
}

async function openStudioCustomizeIfNeeded(page: Page): Promise<Locator | null> {
  const open = await studioCustomizeRoot(page);
  if (open) return open;
  const customizeBtns = page.getByRole("button", { name: /カスタマイズ|Customize/i });
  const n = Math.min(await customizeBtns.count().catch(() => 0), 12);
  for (let i = 0; i < n; i++) {
    const btn = customizeBtns.nth(i);
    if (!(await isVisibleNow(btn))) continue;
    const text = `${await innerTextNow(btn, 0)} ${await attrNow(btn, "aria-label")}`;
    if (isChatCustomizeLabel(text)) continue;
    log("Studio: カスタマイズを開いて形式を選びます");
    await btn.click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    break;
  }
  return studioCustomizeRoot(page);
}

async function selectPresenterSlideFormat(page: Page): Promise<void> {
  log("スライド形式: プレゼンターのスライドを探します");
  const root = await openStudioCustomizeIfNeeded(page);
  if (!root) {
    warn("スライド形式: カスタマイズダイアログが無いので形式選択を飛ばします");
    return;
  }
  const groups = [
    root.getByText(/プレゼンターのスライド|Presenter Slides|Presenter'?s slides/i),
    root.getByRole("radio"),
    root.getByRole("tab"),
    root.getByRole("button"),
    root.locator("[role='option']"),
  ];
  for (const group of groups) {
    const n = Math.min(await group.count().catch(() => 0), 40);
    for (let i = 0; i < n; i++) {
      const el = group.nth(i);
      if (!(await isVisibleNow(el))) continue;
      const text = `${await innerTextNow(el, 0)} ${await attrNow(el, "aria-label")}`
        .replace(/\s+/g, " ")
        .trim();
      if (!isPresenterSlideFormatText(text)) continue;
      await el.click({ timeout: 5_000 });
      log(`スライド形式: プレゼンターのスライドを選びました（${text.slice(0, 40)}）`);
      await page.waitForTimeout(500);
      return;
    }
  }
  const clicked = await clickFirstByName(
    page,
    [/プレゼンターのスライド/, /Presenter Slides/i, /Presenter'?s slides/i],
    { timeoutMs: 4_000 },
  );
  if (clicked) log("スライド形式: プレゼンターのスライドをクリックしました");
  else warn("プレゼンターのスライドが見つかりません。詳細なスライドのまま生成する可能性があります");
}

async function generateStudioItem(
  page: Page,
  labels: (string | RegExp)[],
  timeoutMs: number,
  opts: { explainerVideo?: boolean; stage?: StageId; kickoff?: boolean } = {},
): Promise<"complete" | "started"> {
  await dismissStudioViewer(page);
  await dismissStudioCustomize(page);
  await dismissNotebookLmPopups(page);
  await openSourcesPanel(page);
  const body = await notebookBody(page);
  if (!textHasReadySources(body) || textHasZeroSources(body) || textHasEmptySourceList(body)) {
    throw new Error("ソースが 0 件のため Studio 生成を開始できません");
  }
  log(`Studio: ${String(labels[0])} を開きます`);
  const hit = await clickStudioTile(page, labels);
  if (!hit) {
    await logVisibleButtonNames(page);
    throw new Error(`Studio 項目が見つかりません: ${labels[0]}`);
  }
  await dismissSourceDeleteMenu(page);

  let customize = await waitForAnyVisible(
    page,
    [
      page.getByRole("dialog"),
      page.locator(".cdk-overlay-pane"),
      page.getByRole("button", { name: /^生成$/ }),
      page.getByRole("button", { name: /^作成$/ }),
    ],
    6_000,
  );
  if (!customize) {
    const chevron = page
      .locator("button, [role='button']")
      .filter({ hasText: labels[0] })
      .filter({ hasText: /chevron_forward|chevron_right/i });
    if (await chevron.last().isVisible({ timeout: 0 }).catch(() => false)) {
      log("Studio: タイルの chevron をクリックして生成画面を開きます");
      await chevron.last().click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      await dismissSourceDeleteMenu(page);
      customize = await waitForAnyVisible(
        page,
        [
          page.getByRole("dialog"),
          page.locator(".cdk-overlay-pane"),
          page.getByRole("button", { name: /^生成$/ }),
          page.getByRole("button", { name: /^作成$/ }),
        ],
        6_000,
      );
    }
  }
  if (!customize) {
    warn("カスタマイズ画面 / 生成ボタンが見えません");
    await logVisibleButtonNames(page);
  }

  if (opts.explainerVideo) {
    await withTimeout(selectExplainerVideoFormat(page), 20_000, "動画形式の選択がタイムアウトしました").catch((e) => {
      warn(e instanceof Error ? e.message : String(e));
    });
    const existing = scanStudioVideoOutputs(await studioCardTexts(page));
    log(`Studio: 生成前の ${formatVideoScan(existing)}`);
    if (!shouldKickoffVideo(existing)) {
      log("既存の解説動画があるので生成は押しません");
      await dismissStudioCustomize(page);
      await dismissStudioViewer(page);
      return "started";
    }
  }
  if (opts.stage === "nlm-slides") {
    const cards = await studioCardTexts(page);
    if (!shouldKickoffSlides(cards)) {
      log("既存のスライドがあるので生成は押しません");
      await dismissStudioCustomize(page);
      await dismissStudioViewer(page);
      return "started";
    }
    await withTimeout(selectPresenterSlideFormat(page), 20_000, "スライド形式の選択がタイムアウトしました").catch(
      (e) => {
        warn(e instanceof Error ? e.message : String(e));
      },
    );
  }
  const outputsBefore = await studioOutputCount(page);
  log(`Studio: 生成前の出力カード ${outputsBefore} 件`);
  const generated = await clickStudioGenerate(page);
  if (generated) log("Studio: 生成 をクリックしました");
  else {
    await logVisibleButtonNames(page);
    throw new Error("Studio の生成ボタンを押せませんでした（カスタマイズ画面の右下「生成」）");
  }

  if (opts.kickoff) {
    const confirmUntil = Date.now() + 8_000;
    while (Date.now() < confirmUntil) {
      await clickFailedStudioRetry(page);
      const t = await notebookBody(page);
      const newOutput = (await studioOutputCount(page)) > outputsBefore;
      if (newOutput && !textLooksLikeGenerating(t)) {
        log("Studio: 生成完了とみなします（新しい出力カード）");
        await openLatestStudioOutput(page);
        if (opts.explainerVideo) {
          log("Studio: 動画の長さ表示（ダウンロード可能）を待ちます");
          if (!(await waitUntilVideoDurationVisible(page, 180_000))) {
            warn("動画の長さ表示が出ませんでした。ダウンロードを試みます");
          }
        }
        return "complete";
      }
      if (textLooksLikeStudioFailure(t)) {
        throw new Error("Studio 生成が失敗したままです（再試行が出ています）");
      }
      await page.waitForTimeout(1_000);
    }
    await dismissStudioCustomize(page);
    await dismissStudioViewer(page);
    log(
      `Studio: ${opts.stage ?? "項目"} の生成を開始したので、待ち中に他の Studio も始めます`,
    );
    return "started";
  }

  const start = Date.now();
  let loggedWait = false;
  let firstGeneratingAt = 0;
  let lastBeat = Date.now();
  while (Date.now() - start < timeoutMs) {
    await clickFailedStudioRetry(page);
    const t = await notebookBody(page);
    const generating = textLooksLikeGenerating(t);
    if (textLooksLikeStudioFailure(t) && !generating && Date.now() - start > 45_000) {
      throw new Error("Studio 生成が失敗したままです（再試行が出ています）");
    }
    if (generating && !loggedWait) {
      log("Studio: 生成中です");
      loggedWait = true;
      firstGeneratingAt = Date.now();
    }
    if (loggedWait && Date.now() - lastBeat > 60_000) {
      log("Studio: 生成待ちを継続中");
      lastBeat = Date.now();
    }
    if (/失敗|couldn't generate/i.test(t) && /生成|Generate/i.test(t)) {
      warn("生成エラーらしき文言があります。継続して待ちます。");
    }
    const newOutput = (await studioOutputCount(page)) > outputsBefore;
    if (newOutput && !generating && Date.now() - start > 10_000) {
      log("Studio: 生成完了とみなします（新しい出力カード）");
      await openLatestStudioOutput(page);
      if (opts.explainerVideo) {
        log("Studio: 動画の長さ表示（ダウンロード可能）を待ちます");
        if (!(await waitUntilVideoDurationVisible(page, 180_000))) {
          warn("動画の長さ表示が出ませんでした。ダウンロードを試みます");
        }
      }
      return "complete";
    }
    if (!loggedWait && !newOutput && Date.now() - start > STUDIO_START_STALL_MS) {
      await logVisibleButtonNames(page);
      throw new Error(
        "Studio 生成が始まっていません（生成待ちではなく操作失敗）。すぐやり直します",
      );
    }
    if (
      opts.stage &&
      loggedWait &&
      Date.now() - firstGeneratingAt >= YIELD_AFTER_GENERATING_MS
    ) {
      log(`Studio: 生成は継続中。Chrome を他の論文へ明け渡します（${opts.stage}）`);
      throw new GenerationWaitingError(opts.stage);
    }
    await page.waitForTimeout(2000);
  }
  throw new Error("Studio 生成がタイムアウトしました");
}

async function openMenuOnCard(page: Page, anchor: ReturnType<Page["getByText"]>): Promise<boolean> {
  const card = anchor.locator("xpath=ancestor::*[.//button][1]");
  const inCard = card.getByRole("button", {
    name: /more_vert|more_horiz|その他の操作|その他|More options|More actions|メニュー/i,
  });
  if (await inCard.first().isVisible({ timeout: 0 }).catch(() => false)) {
    await inCard.first().click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    return true;
  }
  const buttons = card.getByRole("button");
  const n = await buttons.count().catch(() => 0);
  if (n > 0) {
    await buttons.nth(n - 1).click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    return true;
  }
  await anchor.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  return true;
}

async function openStudioOutputMenu(page: Page): Promise<boolean> {
  await expandNotebookPanels(page);
  const stamp = page.getByText(STUDIO_RELATIVE_TIME).first();
  if (!(await stamp.isVisible({ timeout: 0 }).catch(() => false))) return false;
  return openMenuOnCard(page, stamp);
}

async function studioHasVideoOutput(page: Page): Promise<boolean> {
  await expandNotebookPanels(page);
  return page.getByText(/\b\d{1,2}:\d{2}\b/).first().isVisible({ timeout: 0 }).catch(() => false);
}

async function studioCardTexts(page: Page): Promise<string[]> {
  await expandNotebookPanels(page);
  const rows: string[] = [];
  const add = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t && !rows.includes(t)) rows.push(t);
  };
  const stamps = page.getByText(STUDIO_RELATIVE_TIME);
  const n = Math.min(await stamps.count().catch(() => 0), 16);
  for (let i = 0; i < n; i++) {
    const card = stamps.nth(i).locator("xpath=ancestor::*[.//button][1]");
    add(await card.innerText({ timeout: 2_000 }).catch(() => ""));
  }
  const durations = page.getByText(/\b\d{1,2}:\d{2}\s*·\s*(解説|Explainer|説明)/);
  const d = Math.min(await durations.count().catch(() => 0), 8);
  for (let i = 0; i < d; i++) {
    const card = durations.nth(i).locator("xpath=ancestor::*[.//button][1]");
    add(await card.innerText({ timeout: 2_000 }).catch(() => ""));
    add(await durations.nth(i).innerText({ timeout: 1_000 }).catch(() => ""));
  }
  add(await notebookBody(page));
  return rows;
}

async function scanPageVideoOutputs(page: Page): Promise<VideoKickoffScan> {
  await revealStudioOutputs(page);
  return scanStudioVideoOutputs(await studioCardTexts(page));
}

async function peekStudioVideoOutputs(page: Page): Promise<VideoKickoffScan> {
  return scanPageVideoOutputs(page);
}

async function studioHasExplainerVideoOutput(page: Page): Promise<boolean> {
  const scan = await scanPageVideoOutputs(page);
  if (scan.explainerCount > 0) return true;
  if (scan.shortCount > 0) {
    const sec = scan.durationsSec.find((s) => s < 120) ?? 0;
    const mm = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, "0");
    log(`既存動画が ${mm}:${ss} のためショートとみなし、説明動画を作り直します`);
  }
  return false;
}

async function openStudioVideoMenu(page: Page): Promise<boolean> {
  await expandNotebookPanels(page);
  const duration = page.getByText(/\b\d{1,2}:\d{2}\b/).first();
  if (await duration.isVisible().catch(() => false)) {
    return openMenuOnCard(page, duration);
  }
  return openStudioOutputMenu(page);
}

const LIST_ARTIFACTS_IN_PAGE = String.raw`async () => {
  const wiz = window.WIZ_global_data || {};
  const at = wiz.SNlM0e || "";
  const parts = location.pathname.split("/").filter(Boolean);
  const notebookId = parts[parts.length - 1] || "";
  const params = JSON.stringify([
    [2],
    notebookId,
    'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"',
  ]);
  const freq = JSON.stringify([[["gArtLc", params, null, "generic"]]]);
  const body = new URLSearchParams({ "f.req": freq });
  if (at) body.set("at", at);
  const res = await fetch(
    "/_/LabsTailwindUi/data/batchexecute?rpcids=gArtLc&source-path=" + encodeURIComponent(location.pathname),
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
      },
      body: body.toString(),
    },
  );
  const text = await res.text();
  const urls = [];
  const add = function (s) {
    const u = String(s).replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    if (/^https?:\/\//.test(u) && urls.indexOf(u) < 0) urls.push(u);
  };
  const walk = function (v, depth) {
    if (depth > 12) return;
    if (typeof v === "string") {
      if (/^https?:/.test(v)) add(v);
      if (v.length > 2 && (v.charAt(0) === "[" || v.charAt(0) === "{")) {
        try { walk(JSON.parse(v), depth + 1); } catch (e) {}
      }
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      for (let i = 0; i < keys.length; i++) walk(v[keys[i]], depth + 1);
    }
  };
  const stripped = text.replace(/^\)\]\}'\s*/, "");
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.charAt(0) !== "[") continue;
    try { walk(JSON.parse(t), 0); } catch (e) {}
  }
  const re = /https?:\\?\/\\?\/[^\s"\\]+/g;
  let m;
  while ((m = re.exec(text))) add(m[0]);
  return { status: res.status, at: Boolean(at), notebookId: notebookId, urls: urls, preview: text.slice(0, 240) };
}`;

async function fetchSlidePdfViaRpc(page: Page, destPath: string): Promise<boolean> {
  const payload = (await page.evaluate(`(${LIST_ARTIFACTS_IN_PAGE})()`).catch((e) => {
    warn(`LIST_ARTIFACTS 失敗: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    return null;
  })) as {
    status: number;
    at: boolean;
    notebookId: string;
    urls: string[];
    preview: string;
  } | null;
  if (!payload) {
    warn("LIST_ARTIFACTS の応答が空です");
    return false;
  }
  log(
    `LIST_ARTIFACTS status=${payload.status} urls=${payload.urls.length} notebook=${payload.notebookId} at=${payload.at}`,
  );
  const hosts = [
    ...new Set(
      payload.urls.map((u) => {
        try {
          return new URL(u).host;
        } catch {
          return u.slice(0, 40);
        }
      }),
    ),
  ];
  log(`LIST_ARTIFACTS hosts: ${hosts.join(" | ")}`);
  const pdfNamed = payload.urls.filter((u) => /\.pdf(\?|$)/i.test(u) || /\/export|\/download/i.test(u));
  const notThumbs = payload.urls.filter((u) => !/lh3\.googleusercontent\.com/i.test(u));
  const candidates = (pdfNamed.length ? pdfNamed : notThumbs.length ? notThumbs : payload.urls).slice(0, 20);
  log(
    `LIST_ARTIFACTS pdfNamed=${pdfNamed.length} notThumbs=${notThumbs.length} try=${candidates.length}`,
  );
  for (const src of candidates) {
    log(`スライド RPC URL: ${src.slice(0, 120)}`);
    if (await fetchUrlToPdf(page, src, destPath) && (await acceptIfRealSlidePdf(destPath))) {
      return true;
    }
  }
  if (payload.urls.length === 0) {
    warn(`LIST_ARTIFACTS 応答先頭: ${payload.preview.replace(/\s+/g, " ")}`);
  }
  return false;
}

async function fetchUrlToPdf(page: Page, src: string, destPath: string): Promise<boolean> {
  if (!/^https?:/i.test(src)) return false;
  try {
    const res = await page.request.get(src, {
      timeout: 60_000,
      maxRedirects: 10,
      headers: { "Accept-Encoding": "identity" },
    });
    if (!res.ok()) return false;
    const buf = Buffer.from(await res.body());
    if (buf.length <= 10_000) return false;
    const head = buf.subarray(0, 5).toString("utf8");
    if (head !== "%PDF-") {
      warn(`URL は PDF ではありません: ${src.slice(0, 64)}`);
      return false;
    }
    writeFileSync(destPath, buf);
    log(`保存: ${destPath}（${buf.length} bytes）`);
    return true;
  } catch (e) {
    warn(`スライド URL 取得に失敗: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    return false;
  }
}

async function clickSlideOverflowMenu(page: Page): Promise<boolean> {
  const clicked = await page
    .evaluate(() => {
      const all = Array.from(document.querySelectorAll("button, [role='button']"));
      const cands = all.filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > window.innerHeight) return false;
        if (r.x < window.innerWidth * 0.5) return false;
        const t = `${(el as HTMLElement).innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-tooltip") || ""}`;
        return /more_vert|その他の操作|その他のオプション|More options|More actions/i.test(t);
      });
      const el = cands.at(-1) as HTMLElement | undefined;
      el?.click();
      return Boolean(el);
    })
    .catch(() => false);
  if (clicked) {
    await page.waitForTimeout(700);
    log("スライド: その他メニューを開きました");
    await logVisibleButtonNames(page);
    return true;
  }
  return false;
}

async function collectSlidePdfUrls(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const out: string[] = [];
      const add = (u: string | null | undefined) => {
        const s = (u ?? "").trim();
        if (s && !out.includes(s)) out.push(s);
      };
      for (const el of document.querySelectorAll("iframe, embed, object, a")) {
        const node = el as HTMLIFrameElement & HTMLAnchorElement;
        add(node.src);
        add(node.href);
        add(el.getAttribute("src"));
        add(el.getAttribute("href"));
        add(el.getAttribute("data-src"));
      }
      return out;
    })
    .catch(() => [] as string[]);
}

async function openSlideDeck(page: Page): Promise<void> {
  await expandNotebookPanels(page);
  await dismissStudioCustomize(page);
  await logStudioCardSummaries(page);
  if (
    await openStudioCardMatching(
      page,
      /Luminous Black Holes|Radiant Black Holes|Illuminated Horizons|The Luminous Void/,
    )
  ) {
    return;
  }
  const stamps = page.getByText(STUDIO_RELATIVE_TIME);
  const n = await stamps.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const stamp = stamps.nth(i);
    const card = stamp.locator("xpath=ancestor::*[.//button][1]");
    const text = await card.innerText({ timeout: 2_000 }).catch(() => "");
    if (!isSlideDeckCardText(text)) continue;
    await stamp.click({ timeout: 5_000 }).catch(() => card.click({ timeout: 5_000 }).catch(() => undefined));
    await page.waitForTimeout(1500);
    return;
  }
  throw new Error("生成済みのスライドカードが Studio にありません");
}

async function acceptIfRealSlidePdf(destPath: string): Promise<boolean> {
  if (!existsSync(destPath)) return false;
  const buf = readFileSync(destPath);
  if (isRealSlidePdf(buf)) {
    log(`スライド PDF 確定: ${destPath}（${buf.length} bytes）`);
    return true;
  }
  warn(`保存した PDF はスライドではありません（${buf.length} bytes）。破棄します`);
  unlinkSync(destPath);
  return false;
}

async function ensureKeeperTab(page: Page): Promise<void> {
  const ctx = page.context();
  if (ctx.pages().filter((p) => !p.isClosed()).length >= 2) return;
  const keeper = await ctx.newPage();
  await keeper.goto("about:blank").catch(() => undefined);
  await page.bringToFront().catch(() => undefined);
}

async function downloadStudioSlidePdf(page: Page, destPath: string): Promise<void> {
  await withTimeout(
    (async () => {
      await ensureKeeperTab(page);
      await openSlideDeck(page);
      if (await fetchSlidePdfViaRpc(page, destPath)) return;
      const embeds = await collectSlidePdfUrls(page);
      log(`スライド埋め込み ${embeds.length} 件`);
      for (const src of embeds) {
        if (!/pdf|googleusercontent|presentation|slides|drive\.google/i.test(src)) continue;
        if (await fetchUrlToPdf(page, src, destPath) && (await acceptIfRealSlidePdf(destPath))) {
          return;
        }
      }
      throw new Error(
        "スライド PDF URL を LIST_ARTIFACTS から取れませんでした（Chrome の PDF ダウンロードはタブを落とすので使いません）",
      );
    })(),
    150_000,
    "スライド保存が 150 秒を超えました",
  );
}

async function waitUntilVideoDurationVisible(page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (page.isClosed()) return false;
    if (await studioHasVideoOutput(page)) return true;
    await page.waitForTimeout(2000).catch(() => undefined);
  }
  return false;
}

const VIDEO_DOWNLOAD_NAMES = [
  /^download$/i,
  /^ダウンロード$/,
  /動画をダウンロード/,
  /Download video/i,
  /Download MP4/i,
  /MP4 をダウンロード/,
];

async function sourceDeleteMenuOpen(page: Page): Promise<boolean> {
  return page.getByText("ソースを削除").first().isVisible({ timeout: 0 }).catch(() => false);
}

async function dismissSourceDeleteMenu(page: Page): Promise<boolean> {
  if (!(await sourceDeleteMenuOpen(page))) return false;
  warn("ソースのメニューを開いてしまったので閉じます（動画のダウンロードではありません）");
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(150);
  if (await sourceDeleteMenuOpen(page)) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.getByRole("heading").first().click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(150);
  }
  return true;
}

async function clickVideoHeaderDownload(page: Page): Promise<boolean> {
  const names = [
    /^download$/i,
    /^file_download$/,
    /^ダウンロード$/,
    /動画をダウンロード/,
    /Download video/i,
  ];
  for (const name of names) {
    const btn = page.getByRole("button", { name });
    if (await btn.first().isVisible({ timeout: 0 }).catch(() => false)) {
      await btn.first().click({ timeout: 5_000 });
      log("Studio: 動画プレーヤーのダウンロードをクリックしました");
      await page.waitForTimeout(400);
      return true;
    }
  }
  return false;
}

/** tsx が関数に __name を付けるため、page.evaluate には文字列だけ渡す */
async function clickExplainerCardOverflow(page: Page): Promise<boolean> {
  const hit = await page
    .evaluate(`(() => {
      const label = (el) => ((el.innerText || "") + " " + (el.getAttribute("aria-label") || "")).replace(/\\s+/g, " ").trim();
      const isOverflow = (t) => /more_vert|more_horiz/i.test(t) || /その他の操作|More options|More actions/i.test(t);
      const explainerCardText = (el) => {
        let cur = el;
        for (let i = 0; i < 12 && cur; i++) {
          const t = (cur.innerText || "").replace(/\\s+/g, " ").trim();
          if (
            t.length <= 280 &&
            /\\d{1,2}:\\d{2}\\s*·\\s*(解説|Explainer|説明)/.test(t) &&
            !/ソースを削除|ソース名を変更|ソースを追加/.test(t) &&
            !(/\\btablet\\b|スライド資料|Slide deck/i.test(t))
          ) {
            return t;
          }
          const root = cur.getRootNode();
          if (root && root.host && root !== document) { cur = root.host; continue; }
          cur = cur.parentElement;
        }
        return "";
      };
      const found = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll("button, [role='button']")) {
          const t = label(el);
          if (!isOverflow(t)) continue;
          const ctx = explainerCardText(el);
          if (!ctx) continue;
          let near = false;
          const video = document.querySelector("video");
          if (video) {
            const vr = video.getBoundingClientRect();
            const er = el.getBoundingClientRect();
            near = er.left < vr.right + 80 && er.right > vr.left - 80 && er.top < vr.bottom + 80 && er.bottom > vr.top - 80;
          }
          const score = (ctx ? 2 : 0) + (near ? 1 : 0);
          if (score > 0) found.push({ el, score });
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      found.sort((a, b) => b.score - a.score);
      if (!found[0]) return "";
      found[0].el.click();
      return found[0].score > 1 ? "explainer" : "near";
    })()`)
    .catch((e) => {
      warn(`解説カードメニュー: ${e instanceof Error ? e.message : e}`);
      return "";
    });
  if (hit) {
    log(`Studio: 解説カードのその他メニューを開きました（${hit}）`);
    await page.waitForTimeout(500);
    if (await dismissSourceDeleteMenu(page)) return false;
    return true;
  }
  return false;
}

async function clickLabeledControl(
  page: Page,
  kind: "download" | "overflow",
): Promise<boolean> {
  const hit = await page
    .evaluate(
      `(() => {
      const which = ${JSON.stringify(kind)};
      const download = (t) => {
        const s = String(t).replace(/\\s+/g, " ").trim();
        if (!s) return false;
        if (/ノートブックを作成|ソースを追加|Google アプリ|ソースを削除/.test(s)) return false;
        if (/\\bdownload\\b|file_download/i.test(s) || /ダウンロード/.test(s)) return true;
        return /動画をダウンロード|Download video|Download MP4|MP4 をダウンロード/i.test(s);
      };
      const overflow = (t) => {
        const s = String(t).replace(/\\s+/g, " ").trim();
        return /more_vert|more_horiz/i.test(s) || /その他の操作|More options|More actions/i.test(s);
      };
      const pred = which === "download" ? download : overflow;
      const nearVideo = (el) => {
        const video = document.querySelector("video");
        if (!video) return false;
        const vr = video.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        if (er.width < 2 || er.height < 2) return false;
        const overlay = el.closest("[role='dialog'], .cdk-overlay-pane");
        if (overlay && overlay.contains(video)) return true;
        const pad = 80;
        return er.left < vr.right + pad && er.right > vr.left - pad && er.top < vr.bottom + pad && er.bottom > vr.top - pad;
      };
      const walk = (root) => {
        const els = Array.from(root.querySelectorAll("button, [role='button'], [role='menuitem']"));
        const ranked = which === "overflow" ? els.filter(nearVideo) : els;
        const seen = new Set();
        for (const el of ranked) {
          if (seen.has(el)) continue;
          seen.add(el);
          const t = ((el.innerText || "") + " " + (el.getAttribute("aria-label") || "")).replace(/\\s+/g, " ").trim();
          if (!pred(t)) continue;
          el.click();
          return true;
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot && walk(el.shadowRoot)) return true;
        }
        return false;
      };
      return walk(document);
    })()`,
    )
    .catch(() => false);
  if (hit) {
    log(kind === "download" ? "Studio: ダウンロードをクリックしました" : "Studio: その他メニューを開きました");
    await page.waitForTimeout(400);
    if (kind === "overflow" && (await dismissSourceDeleteMenu(page))) return false;
  }
  return Boolean(hit);
}

async function clickExplainerDownloadMenuItem(page: Page): Promise<boolean> {
  const hit = String(
    await page
      .evaluate(
        `(() => {
      const label = (el) => ((el.innerText || "") + " " + (el.getAttribute("aria-label") || "")).replace(/\\s+/g, " ").trim();
      const isDl = (t) => {
        if (!t) return false;
        if (/ソースを削除|ソース名を変更|ノートブックを作成|ソースを追加/.test(t)) return false;
        if (/動画をダウンロード|Download video|Download MP4|MP4 をダウンロード|動画（MP4）/i.test(t)) return true;
        if (/^(download|file_download|ダウンロード)$/i.test(t)) return true;
        return /ダウンロード/.test(t) && t.length < 48;
      };
      const walk = (root) => {
        const els = Array.from(root.querySelectorAll("[role='menuitem'], button, [role='button']"));
        for (const el of els) {
          const t = label(el);
          if (!isDl(t)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          el.click();
          return t.slice(0, 80);
        }
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const nested = walk(el.shadowRoot);
            if (nested) return nested;
          }
        }
        return "";
      };
      return walk(document);
    })()`,
      )
      .catch(() => ""),
  );
  if (hit) {
    log(`Studio: ダウンロードをクリックしました（${hit}）`);
    await page.waitForTimeout(400).catch(() => undefined);
    return true;
  }
  return false;
}

async function clickNotebookLmVideoDownload(page: Page): Promise<boolean> {
  if (!(await clickExplainerCardOverflow(page))) return false;
  if (await clickExplainerDownloadMenuItem(page)) return true;
  warn("解説カードのメニューにダウンロード項目がありません");
  return false;
}

async function writeBufIfVideo(destPath: string, buf: Buffer, label: string): Promise<boolean> {
  if (buf.length <= VIDEO_MIN_BYTES) return false;
  writeFileSync(destPath, buf);
  if (!isRealVideoFile(destPath)) {
    try {
      unlinkSync(destPath);
    } catch {
      /* 破棄できなくても次の取得で上書きする */
    }
    warn(`URL は MP4 ではありません: ${label.slice(0, 64)}（先頭 ${buf.subarray(0, 8).toString("latin1")}）`);
    return false;
  }
  log(`保存: ${destPath}（${buf.length} bytes）`);
  return true;
}

async function fetchUrlInPageToVideo(page: Page, src: string, destPath: string): Promise<boolean> {
  const sink = page as VideoSinkPage;
  await bindVideoSink(sink);
  sink.__ppVideoChunks = [];
  try {
    const ok = await Promise.race([
      page.evaluate(
        `(async (src) => {
          const res = await fetch(src, { credentials: "include", redirect: "follow" });
          if (!res.ok) return false;
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length < ${VIDEO_MIN_BYTES}) return false;
          const push = window["__ppVideoPush"];
          if (typeof push !== "function") return false;
          const step = 32768;
          for (let i = 0; i < buf.length; i += step) {
            const slice = buf.subarray(i, i + step);
            let s = "";
            for (let j = 0; j < slice.length; j++) s += String.fromCharCode(slice[j]);
            await push(btoa(s));
          }
          return true;
        })(${JSON.stringify(src)})`,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 180_000)),
    ]);
    if (!ok) return false;
    const buf = Buffer.concat(sink.__ppVideoChunks ?? []);
    sink.__ppVideoChunks = [];
    return writeBufIfVideo(destPath, buf, src);
  } catch (e) {
    sink.__ppVideoChunks = [];
    warn(`ページ内の動画取得に失敗: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    return false;
  }
}
function cookieHeaderForUrl(
  cookies: { name: string; value: string; domain: string }[],
  src: string,
): string {
  let host = "";
  try {
    host = new URL(src).hostname;
  } catch {
    return "";
  }
  return cookies
    .filter((c) => {
      const d = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
      return `.${host}`.endsWith(d);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

async function fetchUrlToVideo(page: Page, src: string, destPath: string): Promise<boolean> {
  if (!/^https?:/i.test(src)) return false;
  const cookies = await page.context().cookies().catch(() => []);
  const headers: Record<string, string> = {
    "Accept-Encoding": "identity",
    Accept: "video/mp4,application/octet-stream,*/*",
    Referer: page.url() || "https://notebook.google.com/",
  };
  const cookie = cookieHeaderForUrl(cookies, src);
  if (cookie) headers.Cookie = cookie;
  try {
    const res = await fetch(src, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok && res.status !== 206) {
      warn(`動画 URL HTTP ${res.status}: ${src.slice(0, 96)}`);
      return false;
    }
    const reader = res.body?.getReader();
    if (!reader) return false;
    const chunks: Buffer[] = [];
    let total = 0;
    let decided = false;
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      chunks.push(Buffer.from(step.value));
      total += step.value.length;
      if (!decided && total >= 12) {
        decided = true;
        if (!isMp4FtypBuffer(Buffer.concat(chunks).subarray(0, 12))) {
          await reader.cancel().catch(() => undefined);
          warn(
            `URL は MP4 ではありません: ${src.slice(0, 64)}（先頭 ${Buffer.concat(chunks).subarray(0, 8).toString("latin1")}）`,
          );
          return false;
        }
      }
    }
    return writeBufIfVideo(destPath, Buffer.concat(chunks), src);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    warn(`動画 URL 取得に失敗: ${msg}`);
    return false;
  }
}

async function fetchVideoViaRpc(page: Page, destPath: string): Promise<boolean> {
  const payload = (await page.evaluate(`(${LIST_ARTIFACTS_IN_PAGE})()`).catch((e) => {
    warn(`LIST_ARTIFACTS 失敗: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    return null;
  })) as {
    status: number;
    at?: boolean;
    notebookId?: string;
    urls: string[];
    preview?: string;
  } | null;
  if (!payload) return false;
  log(
    `LIST_ARTIFACTS(動画) status=${payload.status} urls=${payload.urls.length} notebook=${payload.notebookId ?? ""} at=${Boolean(payload.at)}`,
  );
  if (!payload.urls.length) {
    warn(`LIST_ARTIFACTS 応答先頭: ${(payload.preview ?? "").replace(/\s+/g, " ")}`);
    return false;
  }
  const hosts = [
    ...new Set(
      payload.urls.map((u) => {
        try {
          return new URL(u).host;
        } catch {
          return u.slice(0, 40);
        }
      }),
    ),
  ];
  log(`LIST_ARTIFACTS hosts: ${hosts.join(" | ")}`);
  const candidates = rankVideoArtifactUrls(payload.urls);
  log(`LIST_ARTIFACTS videoCandidates=${candidates.length}/${payload.urls.length}`);
  for (const src of candidates) {
    log(`動画 RPC URL: ${src.slice(0, 120)}`);
    if (await fetchUrlToVideo(page, src, destPath)) return true;
  }
  return false;
}

type VideoSinkPage = Page & { __ppVideoChunks?: Buffer[]; __ppVideoBound?: boolean };

async function bindVideoSink(page: VideoSinkPage): Promise<void> {
  if (page.__ppVideoBound) return;
  page.__ppVideoChunks = [];
  try {
    await page.exposeFunction("__ppVideoPush", (b64: string) => {
      if (typeof b64 === "string" && b64) page.__ppVideoChunks!.push(Buffer.from(b64, "base64"));
    });
  } catch (e) {
    if (!/already registered|has been already registered/i.test(String(e))) throw e;
  }
  page.__ppVideoBound = true;
}

async function fetchBlobUrlToVideo(page: Page, destPath: string): Promise<boolean> {
  const sink = page as VideoSinkPage;
  await bindVideoSink(sink);
  sink.__ppVideoChunks = [];
  const ok = await page
    .evaluate(
      `(async () => {
        const v = document.querySelector("video");
        const src = (v && (v.currentSrc || v.src)) || "";
        if (!src || src.indexOf("blob:") !== 0) return false;
        const res = await fetch(src);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length < ${VIDEO_MIN_BYTES}) return false;
        const push = window["__ppVideoPush"];
        if (typeof push !== "function") return false;
        const step = 32768;
        for (let i = 0; i < buf.length; i += step) {
          const slice = buf.subarray(i, i + step);
          let s = "";
          for (let j = 0; j < slice.length; j++) s += String.fromCharCode(slice[j]);
          await push(btoa(s));
        }
        return true;
      })()`,
    )
    .catch((e) => {
      warn(`blob 動画取得: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      return false;
    });
  if (!ok || !sink.__ppVideoChunks?.length) return false;
  const buf = Buffer.concat(sink.__ppVideoChunks);
  sink.__ppVideoChunks = [];
  writeFileSync(destPath, buf);
  if (!isRealVideoFile(destPath)) {
    try {
      unlinkSync(destPath);
    } catch {
      /* 破棄できなくても次の取得で上書きする */
    }
    warn("blob から取ったファイルは MP4 ではありません");
    return false;
  }
  log(`保存: ${destPath}（${buf.length} bytes, blob）`);
  return true;
}
async function fetchOpenVideoElement(page: Page, destPath: string): Promise<boolean> {
  const src = String(
    await page
      .evaluate(`(() => {
        const v = document.querySelector("video");
        return (v && (v.currentSrc || v.src)) || "";
      })()`)
      .catch(() => ""),
  );
  if (/^https?:/i.test(src)) {
    if (await fetchUrlToVideo(page, src, destPath)) return true;
  }
  const perfUrls = (await page
    .evaluate(
      `(() => {
        try {
          return performance.getEntriesByType("resource").map((e) => e.name).filter((u) =>
            /\\.(mp4|m4v|mov|webm)(\\?|$)/i.test(u) ||
            /mime=video|video\\/mp4|googlevideo|contribution\\.usercontent\\.google\\.com\\/download/i.test(u)
          );
        } catch (e) {
          return [];
        }
      })()`,
    )
    .catch(() => [])) as string[];
  for (const u of perfUrls.slice(0, 8)) {
    log(`動画 resource URL: ${String(u).slice(0, 120)}`);
    if (await fetchUrlToVideo(page, u, destPath)) return true;
  }
  if (src.startsWith("blob:")) return fetchBlobUrlToVideo(page, destPath);
  return false;}

async function downloadStudioVideoMp4(page: Page, destPath: string): Promise<void> {
  await withTimeout(
    (async () => {
      if (!(await waitUntilVideoDurationVisible(page, 5_000))) {
        warn("動画の長さ表示が出る前にダウンロードを試みます");
      }
      log("Studio の解説カードから MP4 を保存します（再生しません）");
      await ensureKeeperTab(page);
      if (await fetchVideoViaRpc(page, destPath)) return;
      if (page.isClosed()) throw new Error("ブラウザが閉じられています");
      if (!isInteractiveUi()) {
        throw new Error(
          "ヘッドレスでは Studio メニューの動画ダウンロードを使いません（Chrome が落ちる）。RPC で MP4 を取れませんでした",
        );
      }
      const clickDownload = async () => {
        for (let i = 0; i < 12; i++) {
          if (page.isClosed()) throw new Error("ブラウザが閉じられています");
          if (await clickNotebookLmVideoDownload(page)) return;
          await new Promise((r) => setTimeout(r, 1_000));
        }
        throw new Error("ダウンロード操作が見つかりません");
      };
      await waitForDownloadTo(page, destPath, clickDownload, 180_000, VIDEO_MIN_BYTES);
      if (isRealVideoFile(destPath)) return;
      throw new Error("動画 MP4 を Studio から保存できませんでした");
    })(),
    250_000,
    "動画保存が 250 秒を超えたので打ち切ります",
  );
}

async function downloadCurrentArtifact(
  page: Page,
  destPath: string,
  extraClickNames: (string | RegExp)[],
): Promise<void> {
  const clickDownload = async () => {
    const ok = await clickFirstByName(page, [
      ...extraClickNames,
      /PDF.*ダウンロード/,
      /Download PDF/i,
      /動画をダウンロード/,
      /Download video/i,
      /ダウンロード/,
      /^Download$/i,
    ]);
    if (!ok) throw new Error("ダウンロード操作が見つかりません");
  };
  await waitForDownloadTo(page, destPath, clickDownload, 180_000);
}

function csvCell(s: string): string {
  const t = s.replace(/\r\n/g, "\n");
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function pickText(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const t = (v as { text?: unknown }).text;
      if (typeof t === "string" && t.trim()) return t.trim();
    }
  }
  return "";
}

type ExtractedQuiz = {
  question: string;
  options: string[];
  correct: string;
  hint: string;
};

type ExtractedCard = { front: string; back: string };

function normalizeQuizQuestions(arr: unknown[]): ExtractedQuiz[] {
  const out: ExtractedQuiz[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const stem = pickText(q, ["question", "questionText", "prompt", "stem", "text", "title"]);
    if (!stem) continue;
    const rawOpts = q.answerOptions ?? q.options ?? q.choices ?? q.answers;
    if (!Array.isArray(rawOpts)) continue;
    const options: { text: string; correct: boolean }[] = [];
    for (const raw of rawOpts) {
      if (typeof raw === "string") {
        options.push({ text: raw.trim(), correct: false });
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const text = pickText(o, ["text", "answer", "content", "value", "label", "option"]);
      if (!text) continue;
      options.push({
        text,
        correct: Boolean(o.isCorrect || o.is_correct || o.correct || o.isAnswer || o.is_answer || o.isRight),
      });
    }
    if (options.length < 2) continue;
    if (!options.some((x) => x.correct)) {
      const idxRaw = q.correctAnswerIndex ?? q.correctIndex ?? q.answerIndex;
      const idx = typeof idxRaw === "number" ? idxRaw : Number(idxRaw);
      if (Number.isInteger(idx) && options[idx]) options[idx].correct = true;
      else {
        const lab = pickText(q, ["correctAnswer", "correct", "answer"]);
        if (/^[A-Za-z]$/.test(lab) && options[lab.toUpperCase().charCodeAt(0) - 65]) {
          options[lab.toUpperCase().charCodeAt(0) - 65]!.correct = true;
        } else if (lab) {
          const hit = options.find((x) => x.text === lab);
          if (hit) hit.correct = true;
        }
      }
    }
    const ci = options.findIndex((x) => x.correct);
    if (ci < 0) continue;
    out.push({
      question: stem,
      options: options.map((x) => x.text),
      correct: String.fromCharCode(65 + ci),
      hint: pickText(q, ["hint", "hintText", "clue", "tip"]),
    });
  }
  return out;
}

function looksLikeCard(o: unknown): boolean {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const r = o as Record<string, unknown>;
  const front = pickText(r, ["front", "f", "term", "question", "prompt", "word"]);
  const back = pickText(r, ["back", "b", "definition", "answer", "explanation", "meaning"]);
  return Boolean(front && back && !r.answerOptions && !r.options);
}

function normalizeCards(arr: unknown[]): ExtractedCard[] {
  const out: ExtractedCard[] = [];
  for (const item of arr) {
    if (!looksLikeCard(item)) continue;
    const r = item as Record<string, unknown>;
    out.push({
      front: pickText(r, ["front", "f", "term", "question", "prompt", "word"]),
      back: pickText(r, ["back", "b", "definition", "answer", "explanation", "meaning"]),
    });
  }
  return out;
}

function walkFindQuiz(data: unknown, depth = 0): ExtractedQuiz[] {
  if (!data || typeof data !== "object" || depth > 8) return [];
  if (Array.isArray(data)) {
    const qs = normalizeQuizQuestions(data);
    if (qs.length) return qs;
    for (const x of data) {
      const found = walkFindQuiz(x, depth + 1);
      if (found.length) return found;
    }
    return [];
  }
  const o = data as Record<string, unknown>;
  if (Array.isArray(o.quiz)) {
    const qs = normalizeQuizQuestions(o.quiz);
    if (qs.length) return qs;
  }
  for (const v of Object.values(o)) {
    const found = walkFindQuiz(v, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function walkFindCards(data: unknown, depth = 0): ExtractedCard[] {
  if (!data || typeof data !== "object" || depth > 8) return [];
  if (Array.isArray(data)) {
    const cards = normalizeCards(data);
    if (cards.length) return cards;
    for (const x of data) {
      const found = walkFindCards(x, depth + 1);
      if (found.length) return found;
    }
    return [];
  }
  const o = data as Record<string, unknown>;
  for (const key of ["cards", "flashcards"]) {
    if (Array.isArray(o[key])) {
      const cards = normalizeCards(o[key] as unknown[]);
      if (cards.length) return cards;
    }
  }
  for (const v of Object.values(o)) {
    const found = walkFindCards(v, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function quizToCsv(questions: ExtractedQuiz[]): string {
  const maxOpt = Math.max(4, ...questions.map((q) => q.options.length));
  const head = ["Question"];
  for (let i = 0; i < maxOpt; i++) head.push(`Option ${String.fromCharCode(65 + i)}`);
  head.push("Correct Answer", "Hint");
  const lines = [head.map(csvCell).join(",")];
  for (const q of questions) {
    const row = [q.question];
    for (let i = 0; i < maxOpt; i++) row.push(q.options[i] ?? "");
    row.push(q.correct, q.hint);
    lines.push(row.map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function cardsToCsv(cards: ExtractedCard[]): string {
  const lines = ["Front,Back"];
  for (const c of cards) lines.push([c.front, c.back].map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

async function readStudioAppData(page: Page): Promise<unknown | null> {
  let best: string | null = null;
  for (const frame of page.frames()) {
    const raw = (await frame
      .evaluate(`(() => {
        const el = document.querySelector("app-root[data-app-data], [data-app-data]");
        return el ? el.getAttribute("data-app-data") : null;
      })()`)
      .catch(() => null)) as string | null;
    if (raw && raw.length > 2 && (!best || raw.length > best.length)) best = raw;
  }
  if (!best) return null;
  try {
    return JSON.parse(best);
  } catch {
    return null;
  }
}

async function exportCsvViaExtension(page: Page, destPath: string): Promise<void> {
  await dismissStudioCustomize(page);
  const start = Date.now();
  let opened = false;
  while (Date.now() - start < 8_000) {
    opened = await clickFirstByName(page, [/^Export$/i, /書き出し/, /エクスポート/], {
      timeoutMs: 1_500,
    });
    if (opened) break;
    await page.waitForTimeout(400);
  }
  if (!opened) {
    throw new Error("Export 拡張のボタンがありません");
  }
  await page.waitForTimeout(600);
  await waitForDownloadTo(
    page,
    destPath,
    async () => {
      const csv = await clickFirstByName(page, [/^CSV$/, /CSV.*Spreadsheet/i, /Spreadsheet/i]);
      if (!csv) throw new Error("Export 拡張の CSV が見つかりません");
    },
    60_000,
  );
}

async function saveStudioArtifactCsv(
  page: Page,
  destPath: string,
  kind: "quiz" | "flashcards",
): Promise<void> {
  await dismissStudioCustomize(page);
  const deadline = Date.now() + 20_000;
  let data: unknown = null;
  while (Date.now() < deadline) {
    data = await readStudioAppData(page);
    if (data) break;
    await page.waitForTimeout(500);
  }
  if (data) {
    if (kind === "quiz") {
      const questions = walkFindQuiz(data);
      if (questions.length < 3) {
        throw new Error(`クイズの選択問題が足りません（${questions.length} 問）`);
      }
      writeFileSync(destPath, quizToCsv(questions), "utf8");
    } else {
      const cards = walkFindCards(data);
      if (cards.length < 3) {
        throw new Error(`単語帳カードが足りません（${cards.length} 件）`);
      }
      writeFileSync(destPath, cardsToCsv(cards), "utf8");
    }
    log(`保存: ${destPath}`);
    return;
  }
  warn("data-app-data が無いので Export 拡張を試します");
  await exportCsvViaExtension(page, destPath);
}

function collectErrMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function unmarkStaleStudioStarts(page: Page, state: PaperState): Promise<void> {
  const body = await notebookBody(page);
  if (generationStartIsRecent(state)) {
    log("生成開始から間もないので、出力カードがまだ無くてもやり直ししません");
    return;
  }
  if (textLooksLikeGenerating(body)) {
    log("Studio に生成中表示がありますが開始から時間が経っているので、出力の有無で判断します");
  }
  if (studioOutputScanIncomplete(body)) {
    log("Studio 出力カードがまだ無いので開始記録はそのままにします");
    return;
  }
  if (hasStudioStarted(state, "nlm-slides") && !isCompleted(state, "nlm-slides")) {
    const stamps = page.getByText(STUDIO_RELATIVE_TIME);
    const n = Math.min(await stamps.count().catch(() => 0), 16);
    let hasSlideCard = false;
    for (let i = 0; i < n; i++) {
      const card = stamps.nth(i).locator("xpath=ancestor::*[.//button][1]");
      const text = await card.innerText({ timeout: 2_000 }).catch(() => "");
      if (isSlideDeckCardText(text)) {
        hasSlideCard = true;
        break;
      }
    }
    if (!hasSlideCard) {
      log("nlm-slides は開始記録があるが出力も生成中もないので、やり直しします");
      unmarkStudioStarted(state, "nlm-slides");
      if (state.waitingFor === "nlm-slides") state.waitingFor = "";
      saveState(state);
    }
  }
  if (hasStudioStarted(state, "nlm-video") && !isCompleted(state, "nlm-video")) {
    const scan = await scanPageVideoOutputs(page);
    if (scan.explainerCount + scan.shortCount === 0) {
      log("nlm-video は開始記録があるが出力も生成中もないので、やり直しします");
      unmarkStudioStarted(state, "nlm-video");
      state.kickoffRetryAt = "";
      if (state.waitingFor === "nlm-video") state.waitingFor = "";
      saveState(state);
    }
  }
}

async function tryKickoffStudio(
  page: Page,
  state: PaperState,
  stage: StageId,
  labels: (string | RegExp)[],
  timeoutMs: number,
  extra: { explainerVideo?: boolean } = {},
): Promise<"complete" | "started" | "skipped"> {
  if (hasStudioStarted(state, stage)) {
    log(`${stage} はすでに開始済み。待ち中に他の Studio を進めます`);
    return "skipped";
  }
  log(`後で作成は使わず、${stage} を今すぐ生成します`);
  try {
    const r = await generateStudioItem(page, labels, timeoutMs, {
      ...extra,
      stage,
      kickoff: true,
    });
    markStudioStarted(state, stage);
    state.kickoffRetryAt = "";
    state.kickoffRetryStage = "";
    saveState(state);
    return r;
  } catch (e) {
    if (e instanceof GenerationWaitingError) throw e;
    warn(`${stage} の開始に失敗したので後でやり直します: ${collectErrMsg(e)}`);
    state.kickoffRetryAt = new Date(Date.now() + 180_000).toISOString();
    state.kickoffRetryStage = stage;
    saveState(state);
    return "skipped";
  }
}

async function collectReadyStudio(
  page: Page,
  paperDir: string,
  state: PaperState,
  ctx: { skipVideoDownload: boolean },
): Promise<void> {
  if (!isCompleted(state, "nlm-slides")) {
    const dest = join(paperDir, "slides.pdf");
    try {
      if (slidesArtifactReady(dest)) {
        log(`既存のスライド PDF を使います: ${dest}`);
        state.slidePdfPath = dest;
        markCompleted(state, "nlm-slides");
      } else if (await studioHasSlideDeckOutput(page)) {
        if (existsSync(dest)) {
          warn("既存 slides.pdf は NotebookLM 画面のため取り直します");
          unlinkSync(dest);
        }
        log("既存のスライド出力から PDF を保存します");
        await downloadStudioSlidePdf(page, dest);
        if (slidesArtifactReady(dest)) {
          state.slidePdfPath = dest;
          markCompleted(state, "nlm-slides");
        }
      }
    } catch (e) {
      warn(`スライドの保存はまだできません: ${collectErrMsg(e)}`);
    }
  }

  const videoDest = join(paperDir, "video.mp4");
  if (artifactReady(videoDest, VIDEO_MIN_BYTES)) {
    if (state.videoMp4Path !== videoDest) {
      log(`既存の動画 MP4 を使います: ${videoDest}`);
      state.videoMp4Path = videoDest;
      saveState(state);
    }
    if (!state.completed.includes("nlm-video") && !state.completed.includes("done")) {
      markCompleted(state, "nlm-video");
    }
  } else if (!ctx.skipVideoDownload) {
    try {
      if (await studioHasExplainerVideoOutput(page)) {
        await dismissPointerBlockers(page);
        log("既存の Studio 動画から MP4 を保存します（再生せず、再生成しません）");
        await downloadStudioVideoMp4(page, videoDest);
        if (artifactReady(videoDest, VIDEO_MIN_BYTES)) {
          state.videoMp4Path = videoDest;
          saveState(state);
          if (!state.completed.includes("nlm-video") && !state.completed.includes("done")) {
            markCompleted(state, "nlm-video");
          }
        }
      }
    } catch (e) {
      const msg = collectErrMsg(e);
      if (
        isTargetClosedError(e) ||
        /ダウンロードボタンが見つかりません|動画保存が |LIST_ARTIFACTS|Chrome ダウンロード|動画 MP4 を Studio/.test(msg)      ) {
        ctx.skipVideoDownload = true;
      }
      warn(`動画の保存はまだできません: ${msg}`);
      if (isTargetClosedError(e) || page.isClosed()) return;
    }
  }

  if (!isCompleted(state, "nlm-quiz")) {
    const dest = join(paperDir, "quiz.csv");
    try {
      if (existsSync(dest) && statSync(dest).size > 80) {
        state.quizCsvPath = dest;
        markCompleted(state, "nlm-quiz");
      } else if (await studioHasCardMatching(page, /クイズ/)) {
        log("既存のクイズを開きます（再生成しません）");
        if (!(await openStudioCardMatching(page, /クイズ/))) {
          await clickFirstByName(page, [/^クイズ$/, /^Quiz$/i, /開く/, /Open/i]);
        }
        await page.waitForTimeout(1500);
        await saveStudioArtifactCsv(page, dest, "quiz");
        if (existsSync(dest)) {
          state.quizCsvPath = dest;
          markCompleted(state, "nlm-quiz");
        }
      }
    } catch (e) {
      warn(`クイズの保存はまだできません: ${collectErrMsg(e)}`);
    }
  }

  if (!isCompleted(state, "nlm-flashcards")) {
    const dest = join(paperDir, "vocab.csv");
    try {
      if (existsSync(dest) && statSync(dest).size > 80) {
        state.vocabCsvPath = dest;
        markCompleted(state, "nlm-flashcards");
      } else if (await studioHasCardMatching(page, /フラッシュ|単語帳|Flashcard/i)) {
        log("既存の単語帳を開きます（再生成しません）");
        if (!(await openStudioCardMatching(page, /フラッシュ|単語帳|Flashcard/i))) {
          await clickFirstByName(page, [/単語帳/, /フラッシュカード/, /Flashcard/i, /開く/]);
        }
        await page.waitForTimeout(1500);
        await saveStudioArtifactCsv(page, dest, "flashcards");
        if (existsSync(dest)) {
          state.vocabCsvPath = dest;
          markCompleted(state, "nlm-flashcards");
        }
      }
    } catch (e) {
      warn(`単語帳の保存はまだできません: ${collectErrMsg(e)}`);
    }
  }
}

async function runStudioParallel(
  page: Page,
  paperDir: string,
  state: PaperState,
  skipStudio: readonly StudioStageId[] = [],
  skipKickoff = false,
): Promise<void> {
  await expandNotebookPanels(page);
  const outputsReady = await waitUntilStudioOutputsReady(page);
  await logStudioCardSummaries(page);
  await unmarkStaleStudioStarts(page, state);

  const want = (stage: StudioStageId) => !skipStudio.includes(stage);
  if (skipStudio.length) {
    log(`Studio 生成対象: ${formatStudioGenerateJa(requiredStudioStages(skipStudio))}`);
  }

  let videoScan: VideoKickoffScan | undefined;
  const studioCollect = { skipVideoDownload: !want("nlm-video") };
  const videoKickoffCooling =
    want("nlm-video") &&
    !isCompleted(state, "nlm-video") &&
    !hasStudioStarted(state, "nlm-video") &&
    state.kickoffRetryStage === "nlm-video" &&
    (Date.parse(state.kickoffRetryAt || "") || 0) > Date.now();
  if (want("nlm-video") && !isCompleted(state, "nlm-video") && !videoKickoffCooling) {
    videoScan = await peekStudioVideoOutputs(page);
    log(`動画スキャン: ${formatVideoScan(videoScan)}`);
    if (!shouldKickoffVideo(videoScan)) {
      log(`既存の解説動画があるので再生成しません（${formatVideoScan(videoScan)}）`);
      markStudioStarted(state, "nlm-video");
    } else if (!outputsReady && hasStudioStarted(state, "nlm-video")) {
      log("Studio 出力カード待ちのため、既存の動画タイルは開きません");
    }
  } else if (videoKickoffCooling) {
    log("nlm-video は開始クールダウン中のため、動画タイルは開きません");
  }

  await collectReadyStudio(page, paperDir, state, studioCollect);

  const kick = async (
    stage: StageId,
    labels: (string | RegExp)[],
    timeoutMs: number,
    extra: { explainerVideo?: boolean } = {},
  ): Promise<void> => {
    if (skipKickoff) return;
    const r = await tryKickoffStudio(page, state, stage, labels, timeoutMs, extra);
    if (r === "complete") await collectReadyStudio(page, paperDir, state, studioCollect);
  };

  if (skipKickoff) {
    log("Notebook 利用量のため新規生成はせず、できている成果物だけ集めます");
  }

  if (want("nlm-slides") && !isCompleted(state, "nlm-slides")) {
    const slideCards = await studioCardTexts(page);
    if (!shouldKickoffSlides(slideCards) || (await studioHasSlideDeckOutput(page))) {
      if (!shouldKickoffSlides(slideCards)) {
        log("既存のスライドがあるので再生成しません");
      }
      markStudioStarted(state, "nlm-slides");
    } else {
      await kick("nlm-slides", [/スライド資料/, /Slide deck/i, /スライドデッキ/], SLIDE_MS);
    }
  }
  if (want("nlm-video") && !isCompleted(state, "nlm-video")) {
    const cooldown = Date.parse(state.kickoffRetryAt || "") || 0;
    if (
      state.kickoffRetryStage === "nlm-video" &&
      cooldown > Date.now() &&
      !hasStudioStarted(state, "nlm-video")
    ) {
      log(
        `nlm-video の開始に失敗した直後なので、${new Date(cooldown).toISOString()} まで生成開始を飛ばします`,
      );
    } else if (!outputsReady && hasStudioStarted(state, "nlm-video")) {
      log("Studio 出力カード待ちのため、動画の生成タイルは開きません");
    } else {
      videoScan = videoScan ?? (await scanPageVideoOutputs(page));
      if (!shouldKickoffVideo(videoScan)) {
        markStudioStarted(state, "nlm-video");
      } else if (studioOutputScanIncomplete(await notebookBody(page))) {
        log("Studio 出力カード待ちのため、動画の生成タイルは開きません");
      } else {
        if (hasStudioStarted(state, "nlm-video") && videoScan.durationsSec.length === 0) {
          const generating = textLooksLikeGenerating(await notebookBody(page));
          if (generating) {
            log("nlm-video の出力カードはまだ無いが生成中なので、開始は維持します");
          } else {
            log("nlm-video は開始記録があるが出力カードが無いので、生成をやり直します");
            unmarkStudioStarted(state, "nlm-video");
          }
        }
        await kick(
          "nlm-video",
          [/動画解説/, /Video overview/i, /^動画$/, /ビデオ概要/],
          VIDEO_MS,
          { explainerVideo: true },
        );
      }
    }
  }
  if (want("nlm-quiz") && !isCompleted(state, "nlm-quiz")) {
    if (await studioHasCardMatching(page, /クイズ/)) markStudioStarted(state, "nlm-quiz");
    else await kick("nlm-quiz", [/^クイズ$/, /^Quiz$/i], QUIZ_MS);
  }
  if (want("nlm-flashcards") && !isCompleted(state, "nlm-flashcards")) {
    if (await studioHasCardMatching(page, /フラッシュ|単語帳|Flashcard/i)) {
      markStudioStarted(state, "nlm-flashcards");
    } else {
      await kick(
        "nlm-flashcards",
        [/フラッシュ/, /フラッシュカード/, /単語帳/, /Flashcard/i, /Flash cards/i],
        QUIZ_MS,
      );
    }
  }

  await collectReadyStudio(page, paperDir, state, studioCollect);

  if (want("nlm-video") && !isCompleted(state, "nlm-video")) {
    videoScan = videoScan ?? (await scanPageVideoOutputs(page));
    if (studioVideoGenerationDone(videoScan)) {
      log(
        `解説動画の生成は終わっているので、MP4 が無くても次の作業へ進みます（${formatVideoScan(videoScan)}）`,
      );
      markCompleted(state, "nlm-video");
    }
  }

  await dismissPointerBlockers(page);
  await dismissStudioViewer(page);

  const pending = firstPendingStudioStage(state, skipStudio);
  if (!pending) return;
  if (skipKickoff) {
    log(`Notebook 利用量のため ${pending} 以降の生成は後回しにします`);
    return;
  }
  if (!studioKickoffSettled(state, skipStudio)) {
    const cooldown = Date.parse(state.kickoffRetryAt || "") || 0;
    if (cooldown > Date.now()) {
      throw new GenerationWaitingError(pending);
    }
    const body = await notebookBody(page).catch(() => "");
    if (studioOutputScanIncomplete(body)) {
      log("Studio 出力カード待ちなので、この論文は後回しにします");
      state.kickoffRetryAt = new Date(Date.now() + 180_000).toISOString();
      state.kickoffRetryStage = pending;
      saveState(state);
      throw new GenerationWaitingError(pending);
    }
    throw new Error(`${pending} を開始できませんでした`);
  }
  const waitingStage = waitingStudioStage(state, skipStudio) ?? pending;
  throw new GenerationWaitingError(waitingStage);
}

export async function runNotebookLm(
  page: Page,
  opts: {
    homeUrl: string;
    pdfPath: string;
    paperDir: string;
    state: PaperState;
    skipSlidesVideo?: boolean;
    studioSkip?: readonly StudioStageId[];
    quota?: NotebookQuotaConfig;
    skipKickoff?: boolean;
  },
): Promise<void> {
  const { homeUrl, pdfPath, paperDir, state, skipSlidesVideo = false } = opts;
  const skipKickoff = opts.skipKickoff === true;
  const skipStudio: readonly StudioStageId[] =
    opts.studioSkip ?? (skipSlidesVideo ? ["nlm-slides", "nlm-video"] : []);
  forgetUnstableNotebook(state);
  const should = (id: Parameters<typeof isCompleted>[1]) => !isCompleted(state, id);
  const wantStudio = (id: StudioStageId) => !skipStudio.includes(id);
  const needVideoFile =
    wantStudio("nlm-video") &&
    !videoFileReady(paperDir, state.videoMp4Path) &&
    (state.completed.includes("nlm-video") || state.completed.includes("done"));
  const shouldStudio = (id: StudioStageId) => {
    if (!wantStudio(id)) return false;
    return should(id);
  };
  if (
    !needVideoFile &&
    !should("nlm-create") &&
    !should("nlm-upload") &&
    !shouldStudio("nlm-slides") &&
    !shouldStudio("nlm-video") &&
    !shouldStudio("nlm-quiz") &&
    !shouldStudio("nlm-flashcards")
  ) {
    if (needVideoFile) {
      log(
        "解説動画は生成済みです。MP4 の RPC 保存は Chrome を落とすことがあるので Studio は開かず、SciSpace / Edu Share を先に進めます",
      );
    }
    return;
  }

  try {
    if (should("nlm-create")) {
      if (skipKickoff) {
        log("Notebook 利用量のためノート作成は後回しにします");
        return;
      }
      state.notebooklmUrl = canonicalNotebookUrl(await createNotebook(page, homeUrl));
      markCompleted(state, "nlm-create");
    } else if (state.notebooklmUrl) {
      await ensureOnNotebook(page, state.notebooklmUrl);
    }

    await forgetMissingSource(page, state, pdfPath);

    if (should("nlm-upload")) {
      if (skipKickoff) {
        log("Notebook 利用量のため PDF 掲載は後回しにします");
        return;
      }
      if (!state.notebooklmUrl) {
        await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
      } else {
        await ensureOnNotebook(page, state.notebooklmUrl);
      }
      await uploadPdfToNotebook(page, pdfPath);
      if (isNotebookDocumentUrl(page.url())) state.notebooklmUrl = canonicalNotebookUrl(page.url());
      else if (!state.notebooklmUrl) state.notebooklmUrl = canonicalNotebookUrl(page.url());
      markCompleted(state, "nlm-upload");
    }

    const kicking =
      shouldStudio("nlm-slides") ||
      shouldStudio("nlm-video") ||
      shouldStudio("nlm-quiz") ||
      shouldStudio("nlm-flashcards");
    if (kicking && !skipKickoff && !needVideoFile && opts.quota && !opts.quota.ignoreNotebookQuota) {      const quota = await loadNotebookQuota(opts.quota);
      const pause = notebookGenerationPause(
        quota,
        Date.now(),
        opts.quota.notebookShortStopPercent,
        opts.quota.notebookWeeklyStopPercent,
      );
      if (pause && quota) throw new NotebookQuotaPauseError(pause, quota);
    }
    if (kicking || needVideoFile) {
      if (!state.notebooklmUrl) {
        if (skipKickoff && !needVideoFile) return;
        throw new Error("NotebookLM の URL がありません");
      }
      if (needVideoFile) {
        log("解説動画は生成済みなので、MP4 だけ Studio から保存して Edu Share へ載せます");
      }
      await ensureOnNotebook(page, state.notebooklmUrl);
      await runStudioParallel(page, paperDir, state, skipStudio, skipKickoff || needVideoFile);
    }
  } catch (e) {
    if (e instanceof GenerationWaitingError) throw e;
    if (e instanceof NotebookQuotaPauseError) throw e;
    if (skipKickoff && isTargetClosedError(e)) {
      warn("利用量待ちの収集中にブラウザが閉じました。手元のファイルで続けます");
      return;
    }
    await saveFailureShot(page, paperDir, "notebooklm");
    throw e;
  }
}
