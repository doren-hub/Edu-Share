import { existsSync } from "node:fs";
import type { Page } from "playwright";
import { pauseIfBlocked } from "../human.ts";
import { log, warn } from "../log.ts";
import { isOtherIndustryValue, pickPaperIndustry } from "../match.ts";
import { stripTldrSnippetNumbers } from "../scispace-card.ts";
import { isCompleted, markCompleted, type PaperState } from "../state.ts";
import { fillIfVisible, saveFailureShot } from "../ui.ts";

function isDummySciSpacePaste(paste: string, filename: string): boolean {
  const t = paste.trim().toLowerCase();
  if (!t) return true;
  const stem = filename.replace(/\.pdf$/i, "").toLowerCase();
  return t === stem || t === filename.toLowerCase();
}

async function uploadFormReady(page: Page): Promise<boolean> {
  if (!/\/upload(?:\?|$)/.test(page.url())) return false;
  const input = page.locator('input[type="file"][accept*="pdf"], input[type="file"]');
  if ((await input.count()) === 0) return false;
  const t = await page.locator("body").innerText().catch(() => "");
  if (/ログインが必要/.test(t)) return false;
  return Boolean(await page.getByRole("button", { name: "アップロードして取り込み" }).count());
}

async function onEduShareLoginPage(page: Page): Promise<boolean> {
  return /\/auth\/login|\/auth\/signup/.test(page.url());
}

async function maybeLoginEduShare(
  page: Page,
  baseUrl: string,
  email: string,
  password: string,
): Promise<void> {
  if (await onEduShareLoginPage(page)) {
    if (email && password) {
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      await page.getByRole("button", { name: /ログイン/ }).click();
      await page.waitForURL((u) => !/\/auth\/login/.test(u.href), { timeout: 30_000 }).catch(
        () => undefined,
      );
    }
    return;
  }
  const t = await page.locator("body").innerText().catch(() => "");
  if (!/ログインが必要/.test(t)) return;
  const loginLink = page.getByRole("link", { name: /^ログイン$/ });
  if (await loginLink.first().isVisible().catch(() => false)) {
    await loginLink.first().click();
    await page.waitForTimeout(800);
  } else {
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "domcontentloaded" });
  }
}

async function gotoLoggedIn(page: Page, url: string, cfg: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await pauseIfBlocked(page, "Edu Share");
  await maybeLoginEduShare(page, cfg.baseUrl, cfg.email, cfg.password);
  if (await onEduShareLoginPage(page)) return;
  const want = new URL(url).pathname;
  let here = "";
  try {
    here = new URL(page.url()).pathname;
  } catch {
    here = page.url();
  }
  if (!here.startsWith(want)) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
}

async function waitUntilUploadForm(page: Page, baseUrl: string): Promise<void> {
  if (await uploadFormReady(page)) return;
  if (/ログインが必要/.test(await page.locator("body").innerText().catch(() => ""))) {
    log("Edu Share のログイン画面を開きます。入力中は操作しません");
    await maybeLoginEduShare(page, baseUrl, "", "");
  }
  log("Edu Share: ログインが終わるまで画面を触りません");
  const deadline = Date.now() + 10 * 60_000;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    if (await uploadFormReady(page)) return;
    if (
      !(await onEduShareLoginPage(page)) &&
      !/ログインが必要/.test(await page.locator("body").innerText().catch(() => ""))
    ) {
      if (!/\/upload/.test(page.url())) {
        await page.goto(`${baseUrl}/upload`, { waitUntil: "domcontentloaded" });
      }
      if (await uploadFormReady(page)) return;
    }
    if (Date.now() - lastBeat > 30_000) {
      log("Edu Share: ログイン待ち（画面は触っていません）");
      lastBeat = Date.now();
    }
    await page.waitForTimeout(2000);
  }
  throw new Error("Edu Share の PDF アップロード画面に入れません（ログインが必要です）");
}

export async function collectExistingPapers(
  page: Page,
  baseUrl: string,
  auth: { email: string; password: string },
): Promise<{ title: string; doi: string }[]> {
  await gotoLoggedIn(page, `${baseUrl}/tests/paper`, { baseUrl, ...auth });
  await page.waitForTimeout(800);
  const titles = (await page.locator("h2").allTextContents())
    .map((t) => t.trim())
    .filter((t) => t && t !== "論文一覧");
  const dois: string[] = [];
  const buttons = page.locator("button");
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const text = ((await buttons.nth(i).innerText().catch(() => "")) ?? "").trim();
    if (/^10\.\d{4,}\//.test(text)) dois.push(text);
  }
  const papers: { title: string; doi: string }[] = [
    ...titles.map((title) => ({ title, doi: "" })),
    ...dois.map((doi) => ({ title: "", doi })),
  ];
  log(`Edu Share 論文一覧: タイトル ${titles.length} / DOI ${dois.length}`);
  return papers;
}

async function waitAutofillSettled(page: Page): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    const t = await page.locator("body").innerText().catch(() => "");
    if (/自動入力しました|自動入力はスキップ|自動入力に失敗/.test(t)) return;
    if (!/自動入力しています/.test(t) && Date.now() - start > 8_000) {
      const industry = await page.locator("#paper-industry").inputValue().catch(() => "");
      const title = await page.locator('label').filter({ hasText: "タイトル" }).locator("input").inputValue().catch(() => "");
      if (industry || title) return;
    }
    await page.waitForTimeout(500);
  }
  warn("PDF 自動入力の完了表示を確認できませんでした");
}

async function ensureIndustry(page: Page, haystack: string): Promise<void> {
  const select = page.locator("#paper-industry");
  if (!(await select.isVisible({ timeout: 0 }).catch(() => false))) {
    await select.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
  }
  if (!(await select.isVisible({ timeout: 0 }).catch(() => false))) {
    warn("業界欄が見えないのでスキップ");
    return;
  }
  const current = await select.inputValue().catch(() => "");
  const options = await select.locator("option").allTextContents();
  const values = options.map((o) => o.trim()).filter((o) => o && o !== "選択してください");
  const best = pickPaperIndustry(values, haystack);
  if (best && (isOtherIndustryValue(current) || current !== best)) {
    await select.selectOption({ label: best }).catch(async () => {
      await select.selectOption(best);
    });
    log(`業界: ${best}`);
    return;
  }
  if (best && current === best) {
    log(`業界（維持）: ${current}`);
    return;
  }
  warn("業界を自動判定できませんでした。空のままアップロードします");
}

export async function runEduShareUpload(
  page: Page,
  opts: {
    baseUrl: string;
    email: string;
    password: string;
    pdfPath: string;
    paperDir: string;
    state: PaperState;
  },
): Promise<void> {
  const { baseUrl, pdfPath, paperDir, state } = opts;
  if (isCompleted(state, "edu-upload")) return;

  try {
    await gotoLoggedIn(page, `${baseUrl}/upload`, {
      baseUrl,
      email: opts.email,
      password: opts.password,
    });
    await waitUntilUploadForm(page, baseUrl);
    log(`Edu Share アップロード画面: ${page.url()}`);

    const typeSelect = page.locator("select").filter({ has: page.locator('option[value="paper"]') });
    if (await typeSelect.count()) {
      await typeSelect.first().selectOption("paper");
    }

    const pdfInput = page.locator('input[type="file"]').first();
    await pdfInput.setInputFiles(pdfPath);
    await waitAutofillSettled(page);

    if (await typeSelect.count()) {
      await typeSelect.first().selectOption("paper").catch(() => undefined);
    }

    const metaBox = page.locator("textarea.font-mono").first();
    const paste = isDummySciSpacePaste(state.filesPaste, state.filename) ? "" : state.filesPaste.trim();
    if (paste) {
      const filled = await fillIfVisible(metaBox, paste, "SciSpace 貼り付け欄");
      if (filled) {
        const apply = page.getByRole("button", { name: "貼り付けから項目に反映" });
        if (await apply.isVisible({ timeout: 0 }).catch(() => false)) {
          await apply.click({ timeout: 8_000 }).catch(() => undefined);
          await page
            .getByText(/貼り付けを反映|検出できませんでした/)
            .first()
            .waitFor({ timeout: 20_000 })
            .catch(() => undefined);
        }
      }
    }

    if (state.doi) {
      const doiInput = page.locator('input[placeholder*="10."]').first();
      const cur = await doiInput.inputValue().catch(() => "");
      if (!cur.trim()) await fillIfVisible(doiInput, state.doi, "DOI");
    }

    if (state.tldr.trim() && !/agent gallery|^home\b/i.test(state.tldr)) {
      const desc = page.locator("label").filter({ hasText: "説明" }).locator("textarea");
      await fillIfVisible(desc, state.tldr.slice(0, 2000), "説明");
    }

    await ensureIndustry(page, [state.title, state.venue, state.tldr].filter(Boolean).join("\n"));

    await page.getByRole("button", { name: "アップロードして取り込み" }).click();
    await page.waitForURL(/\/tests\/[0-9a-f-]{8,}/i, { timeout: 180_000 });
    state.eduShareTestUrl = page.url();
    const m = page.url().match(/\/tests\/([0-9a-f-]{8,})/i);
    state.eduShareTestId = m?.[1] ?? "";
    log(`Edu Share 論文ページ: ${state.eduShareTestUrl}`);
    markCompleted(state, "edu-upload");
  } catch (e) {
    await saveFailureShot(page, paperDir, "edushare-upload");
    throw e;
  }
}

async function expandSection(page: Page, heading: string): Promise<void> {
  const box = page.getByRole("heading", { name: heading, exact: true }).locator("..");
  const closeBtn = box.getByRole("button", { name: "閉じる" });
  if (await closeBtn.isVisible({ timeout: 0 }).catch(() => false)) return;
  const edit = box.getByRole("button", { name: "編集する" });
  if (await edit.isVisible({ timeout: 0 }).catch(() => false)) {
    await edit.click({ timeout: 5_000 });
    await page.waitForTimeout(400);
  }
}

export async function saveSciSpaceUrlOnEduShare(page: Page, state: PaperState): Promise<void> {
  if (!state.eduShareTestUrl || !state.scispaceUrl) return;
  const onPaper =
    /\/tests\//.test(page.url()) &&
    Boolean(state.eduShareTestId) &&
    page.url().includes(state.eduShareTestId);
  if (!onPaper) {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
  }
  await expandSection(page, "SciSpace");
  const sciInput = page.locator('input[type="url"][placeholder*="scispace.com"]');
  if (!(await sciInput.first().isVisible({ timeout: 0 }).catch(() => false))) {
    const edit = page.getByRole("heading", { name: "SciSpace", exact: true }).locator("..").getByRole(
      "button",
      { name: "編集する" },
    );
    if (await edit.first().isVisible({ timeout: 0 }).catch(() => false)) {
      await edit.first().click({ timeout: 5_000 });
      await page.waitForTimeout(400);
    }
  }
  const filled = await fillIfVisible(sciInput, state.scispaceUrl, "SciSpace URL");
  if (!filled) {
    warn(`SciSpace URL 欄を開けません url=${page.url().slice(0, 80)}`);
    return;
  }
  await page.getByRole("button", { name: "リンクを保存" }).first().click({ timeout: 8_000 });
  await page.getByText("保存しました。").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  log(`Edu Share: SciSpace 個別リンクを保存 ${state.scispaceUrl}`);
}

function paperSection(page: Page, heading: string) {
  return page
    .locator("section, div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) })
    .last();
}

export async function applySciSpaceMetaToPaperPage(
  page: Page,
  opts: { paperDir: string; state: PaperState },
): Promise<void> {
  const { paperDir, state } = opts;
  if (!state.eduShareTestUrl) throw new Error("Edu Share の論文 URL がありません");
  const paste = isDummySciSpacePaste(state.filesPaste, state.filename) ? "" : state.filesPaste.trim();
  const tldr = stripTldrSnippetNumbers(state.tldr.trim());
  const tldrOk = Boolean(tldr) && !/agent gallery|^home\b/i.test(tldr);

  try {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const deadline = Date.now() + 10 * 60_000;
    let logged = false;
    while (Date.now() < deadline) {
      const url = page.url();
      const body = await page.locator("body").innerText().catch(() => "");
      const onLogin = /\/auth\/login|accounts\.google/.test(url) || /ログインが必要/.test(body);
      if (onLogin) {
        if (!logged) {
          log("Edu Share: ログイン中は画面を触りません");
          logged = true;
        }
        await page.waitForTimeout(2000);
        continue;
      }
      if (await page.getByRole("heading", { name: "資料情報" }).isVisible().catch(() => false)) break;
      await page.waitForTimeout(800);
    }

    if (paste) {
      const sci = paperSection(page, "SciSpace");
      await sci.scrollIntoViewIfNeeded();
      if (!(await sci.getByRole("button", { name: "閉じる" }).isVisible().catch(() => false))) {
        await sci.getByRole("button", { name: "編集する" }).click();
        await page.waitForTimeout(500);
      }
      const pasteBox = sci.locator("textarea.font-mono");
      await pasteBox.waitFor({ state: "visible", timeout: 15_000 });
      if (!(await fillIfVisible(pasteBox, paste, "論文ページ SciSpace 貼り付け"))) {
        throw new Error("SciSpace 貼り付け欄に入力できませんでした");
      }
      await sci.getByRole("button", { name: "貼り付けを反映して保存" }).click();
      const note = page.getByText(/メタ情報を保存しました|検出できませんでした|著者が未設定/);
      await note.first().waitFor({ timeout: 60_000 });
      const text = ((await note.first().innerText().catch(() => "")) || "").trim();
      if (/検出できませんでした|著者が未設定|失敗/.test(text)) {
        throw new Error(`SciSpace メタの反映失敗: ${text}`);
      }
      log("Edu Share: SciSpace メタ（タイトル・著者・年・掲載）を保存");
    }

    const info = paperSection(page, "資料情報");
    await info.scrollIntoViewIfNeeded();
    if (!(await info.getByRole("button", { name: "閉じる" }).isVisible().catch(() => false))) {
      await info.getByRole("button", { name: "編集する" }).click();
      await page.waitForTimeout(500);
    }
    if (tldrOk) {
      await fillIfVisible(
        info.locator("label").filter({ hasText: "説明" }).locator("textarea"),
        tldr.slice(0, 2000),
        "資料情報の説明",
      );
    }
    if (state.title.trim()) {
      await fillIfVisible(
        info.locator("label").filter({ hasText: "タイトル" }).locator("input"),
        state.title.slice(0, 200),
        "資料情報のタイトル",
      );
    }
    await ensureIndustry(page, [state.title, state.venue, tldr].filter(Boolean).join("\n"));
    await info.getByRole("button", { name: "変更を保存" }).click();
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      if (await info.getByRole("button", { name: "編集する" }).isVisible().catch(() => false)) break;
      const err = ((await page.getByRole("alert").first().innerText().catch(() => "")) || "").trim();
      if (err) throw new Error(`資料情報の保存失敗: ${err}`);
      await page.waitForTimeout(400);
    }
    log("Edu Share: 資料情報（説明・業界）を保存");
  } catch (e) {
    await saveFailureShot(page, paperDir, "edushare-scispace-meta");
    throw e;
  }
}

async function importedPoolCount(page: Page): Promise<number> {
  const body = await page.locator("body").innerText().catch(() => "");
  return [...body.matchAll(/取り込み済み（(\d+)問）/g)].filter((m) => Number(m[1]) >= 3).length;
}

async function importNotebookLmCsv(
  page: Page,
  destPath: string,
  inputIndex: number,
  buttonName: string,
  successText: string,
  minImported: number,
): Promise<void> {
  await expandSection(page, "NotebookLM");
  const csvInputs = page.locator('input[type="file"][accept*="csv"]');
  await csvInputs.nth(inputIndex).setInputFiles(destPath);
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: buttonName }).click({ timeout: 8_000 });
  const success = page.getByText(successText);
  const alert = page.getByRole("alert");
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    if (await success.isVisible({ timeout: 0 }).catch(() => false)) break;
    const err = ((await alert.first().innerText().catch(() => "")) || "").trim();
    if (err) throw new Error(`${buttonName} 失敗: ${err}`);
    await page.waitForTimeout(400);
  }
  const bodyDeadline = Date.now() + 20_000;
  while (Date.now() < bodyDeadline) {
    if ((await importedPoolCount(page)) >= minImported) {
      log(`Edu Share: ${successText}`);
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`${successText} のあと、取り込み済み件数がページに出ませんでした`);
}

export async function runEduShareMaterials(
  page: Page,
  opts: {
    paperDir: string;
    state: PaperState;
  },
): Promise<void> {
  const { paperDir, state } = opts;
  if (isCompleted(state, "edu-materials")) return;
  if (!state.eduShareTestUrl) throw new Error("Edu Share の論文 URL がありません");

  try {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
    await expandSection(page, "NotebookLM");
    const already = await page.locator("body").innerText().catch(() => "");

    if (state.quizCsvPath && existsSync(state.quizCsvPath)) {
      await importNotebookLmCsv(
        page,
        state.quizCsvPath,
        0,
        "クイズ CSV を取り込む",
        "クイズ CSV を取り込みました。",
        1,
      );
    }
    if (state.vocabCsvPath && existsSync(state.vocabCsvPath)) {
      await importNotebookLmCsv(
        page,
        state.vocabCsvPath,
        1,
        "単語帳 CSV を取り込む",
        "単語帳（Flashcard）CSV を取り込みました。",
        2,
      );
    }

    if (state.slidePdfPath && existsSync(state.slidePdfPath)) {
      await expandSection(page, "NotebookLM");
      await page.locator('input[type="file"][accept*="pdf"]').last().setInputFiles(state.slidePdfPath);
      await page.getByText("スライド用 PDF を登録しました。").waitFor({ timeout: 120_000 }).catch(
        () => warn("スライド登録の完了表示がありません"),
      );
    }
    if (state.videoMp4Path && existsSync(state.videoMp4Path) && !/動画（MP4）/.test(already)) {
      await expandSection(page, "NotebookLM");
      await page.locator('input[type="file"][accept*="mp4"]').first().setInputFiles(
        state.videoMp4Path,
      );
      await page.getByText("動画 MP4 を登録しました。").waitFor({ timeout: 180_000 }).catch(() =>
        warn("動画登録の完了表示がありません"),
      );
    }

    if (state.notebooklmUrl) {
      await expandSection(page, "NotebookLM");
      const urlInput = page.getByPlaceholder("https://notebooklm.google.com/");
      await fillIfVisible(urlInput, state.notebooklmUrl, "NotebookLM URL");
      await page.getByRole("heading", { name: "NotebookLM" }).locator("..").getByRole(
        "button",
        { name: "リンクを保存" },
      ).click();
      await page.getByText("保存しました。").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
    }

    await applySciSpaceMetaToPaperPage(page, { paperDir, state });

    await expandSection(page, "SciSpace");
    if (state.scispaceUrl) {
      await saveSciSpaceUrlOnEduShare(page, state);
    }

    markCompleted(state, "edu-materials");
  } catch (e) {
    await saveFailureShot(page, paperDir, "edushare-materials");
    throw e;
  }
}

export async function verifyEduSharePaper(
  page: Page,
  opts: { paperDir: string; state: PaperState },
): Promise<void> {
  const { paperDir, state } = opts;
  if (isCompleted(state, "verify")) return;
  if (!state.eduShareTestUrl) throw new Error("Edu Share の論文 URL がありません");

  try {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
    const pending = /pending|processing|解析/i.test(await page.locator("body").innerText().catch(() => ""));
    const deadline = Date.now() + (pending ? 180_000 : 25_000);
    let lastBeat = 0;
    const quizStart = page.locator('a[href*="csvPool=quiz"]');
    while (Date.now() < deadline) {
      const csvTab = page.getByRole("tab", { name: "NotebookLM CSV" });
      if (await csvTab.isVisible({ timeout: 0 }).catch(() => false)) {
        await csvTab.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(300);
      }
      if (await quizStart.first().isVisible({ timeout: 0 }).catch(() => false)) break;
      if (Date.now() - lastBeat > 12_000) {
        log("確認: CSV 開始リンク待ち");
        lastBeat = Date.now();
      }
      await page.waitForTimeout(2000);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    const body = await page.locator("body").innerText();

    const hasPdf = /元PDF|新しいタブで開く/.test(body);
    if (!hasPdf) throw new Error("元 PDF の表示が見つかりません");

    const hasSlide = /スライド（PDF）/.test(body);
    const hasVideo = /動画/.test(body);
    if (!hasSlide) warn("スライド枠が見つかりません");
    if (!hasVideo) warn("動画枠が見つかりません");

    if (!(await quizStart.first().isVisible({ timeout: 0 }).catch(() => false))) {
      const take = state.eduShareTestUrl.replace(/\/$/, "") + "/take?csvPool=quiz";
      log("確認: クイズ開始ボタンが無いので CSV プール URL を開きます");
      await page.goto(take, { waitUntil: "domcontentloaded" });
    } else {
      await quizStart.first().click({ timeout: 8_000 });
    }
    await page.waitForURL(/\/tests\/.+\/take/, { timeout: 20_000 });
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
    const csvTab = page.getByRole("tab", { name: "NotebookLM CSV" });
    if (await csvTab.isVisible({ timeout: 0 }).catch(() => false)) {
      await csvTab.click({ timeout: 5_000 }).catch(() => undefined);
    }
    const vocabAgain = page.locator('a[href*="csvPool=vocab"]');
    if (await vocabAgain.first().isVisible({ timeout: 0 }).catch(() => false)) {
      await vocabAgain.first().click({ timeout: 8_000 });
    } else {
      const take = state.eduShareTestUrl.replace(/\/$/, "") + "/take?csvPool=vocab";
      log("確認: 単語帳開始ボタンが無いので CSV プール URL を開きます");
      await page.goto(take, { waitUntil: "domcontentloaded" });
    }
    await page.waitForURL(/\/tests\/.+\/take/, { timeout: 20_000 });

    log("確認: PDF/スライド/動画と CSV テスト開始まで到達");
    markCompleted(state, "verify");
  } catch (e) {
    await saveFailureShot(page, paperDir, "verify");
    throw e;
  }
}