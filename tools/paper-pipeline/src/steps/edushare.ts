import { existsSync, readFileSync, statSync } from "node:fs";
import type { Locator, Page } from "playwright";
import { pauseIfBlocked } from "../human.ts";
import { log, warn } from "../log.ts";
import { isOtherIndustryValue, pickPaperIndustry, type ExistingPaper } from "../match.ts";
import { stripTldrSnippetNumbers, descriptionUsable, eduShareSciSpaceMetadataPaste, extractSciSpaceCardMeta, isDummySciSpacePaste, titleLooksLikeFilename } from "../scispace-card.ts";
import {
  choosePaperAuthor,
  isAuthorRequiredError,
  materialCarouselShowLabel,
  paperMaterialIsRegistered,
  SLIDE_MATERIAL_HEADING,
  VIDEO_MATERIAL_HEADING,
} from "../edushare-form.ts";
import { bindEduSharePaper, isCompleted, markCompleted, markEduUploaded, unmarkEduUploaded, type PaperState, type StudioStageId } from "../state.ts";
import { fillIfVisible, saveFailureShot } from "../ui.ts";
import { videoArtifactPath, videoFileReady, ensureUploadableVideo, VIDEO_UPLOAD_MAX_BYTES } from "../video-file.ts";

function shouldSkipSciSpacePaste(paste: string, filename: string): boolean {
  const t = paste.trim().toLowerCase();
  if (!t) return true;
  const stem = filename.replace(/\.pdf$/i, "").toLowerCase();
  if (t === stem || t === filename.toLowerCase()) return true;
  if (isDummySciSpacePaste(paste)) return true;
  return /\b(?:a\.\s*einstein|albert einstein)\b/i.test(paste);
}

function usableEduShareTitle(state: PaperState): string {
  const t = state.title.trim();
  if (!t || isDummySciSpacePaste(t) || titleLooksLikeFilename(t, state.filename)) return "";
  return t.slice(0, 200);
}

function usableEduShareVenue(state: PaperState): string {
  const v = state.venue.trim();
  if (!v || isDummySciSpacePaste(v) || /^(null|undefined)$/i.test(v)) return "";
  return v.slice(0, 400);
}

function usableEduShareYear(state: PaperState): string {
  const y = extractSciSpaceCardMeta(state.filesPaste, state.filename).publicationYear.trim();
  return /^(?:19|20)\d{2}$/.test(y) ? y : "";
}

async function pageBodyText(page: Page, timeoutMs = 8_000): Promise<string> {
  return page.locator("body").innerText({ timeout: timeoutMs }).catch(() => "");
}

async function ensureYearPicklist(page: Page, year: string): Promise<boolean> {
  const raw = await page
    .evaluate(async (y: string) => {
      const res = await fetch("/api/picklists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "publication_year", value: y }),
      });
      return JSON.stringify({ ok: res.ok, status: res.status });
    }, year)
    .catch(() => "");
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; status?: number };
    return Boolean(parsed.ok) || parsed.status === 409;
  } catch {
    return false;
  }
}

async function uploadFormReady(page: Page): Promise<boolean> {
  if (!/\/upload(?:\?|$)/.test(page.url())) return false;
  const input = page.locator('input[type="file"][accept*="pdf"], input[type="file"]');
  if ((await input.count()) === 0) return false;
  const t = await pageBodyText(page);
  if (/ログインが必要/.test(t)) return false;
  return Boolean(await page.getByRole("button", { name: "アップロードして取り込み" }).count());
}

async function onEduShareLoginPage(page: Page): Promise<boolean> {
  return /\/auth\/login|\/auth\/signup/.test(page.url());
}

export async function maybeLoginEduShare(
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
  const t = await pageBodyText(page);
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
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
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
  if (/ログインが必要/.test(await pageBodyText(page))) {
    log("Edu Share のログイン画面を開きます。入力中は操作しません");
    await pauseIfBlocked(page, "Edu Share");
    await maybeLoginEduShare(page, baseUrl, "", "");
  }
  log("Edu Share: ログインが終わるまで画面を触りません");
  const deadline = Date.now() + 10 * 60_000;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    if (await uploadFormReady(page)) return;
    if (
      !(await onEduShareLoginPage(page)) &&
      !/ログインが必要/.test(await pageBodyText(page))
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
): Promise<ExistingPaper[]> {
  await gotoLoggedIn(page, `${baseUrl}/tests/paper`, { baseUrl, ...auth });
  await page.waitForTimeout(800);
  const papers: ExistingPaper[] = [];
  const cards = page.locator('a[href*="/tests/"]');
  const n = await cards.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const href = ((await card.getAttribute("href").catch(() => "")) || "").trim();
    const m = href.match(/\/tests\/([0-9a-f-]{8,})/i);
    const title = ((await card.locator("h2").innerText().catch(() => "")) || "").trim();
    const fromAttr = ((await card.getAttribute("data-pdf-filename").catch(() => "")) || "").trim();
    const body = ((await card.innerText().catch(() => "")) || "").trim();
    const fromText = body.match(/\b([\w.\-]+\.pdf)\b/i)?.[1] ?? "";
    const filename = fromAttr || fromText;
    if (!title && !m && !filename) continue;
    papers.push({
      title,
      doi: "",
      filename: filename || undefined,
      id: m?.[1],
      url: m ? `${baseUrl.replace(/\/$/, "")}/tests/${m[1]}` : undefined,
    });
  }
  const withName = papers.filter((p) => p.filename).length;
  log(`Edu Share 論文一覧: タイトル ${papers.filter((p) => p.title).length} / PDF名 ${withName}`);
  return papers;
}

async function waitAutofillSettled(page: Page): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    const t = await pageBodyText(page);
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

async function uploadFormAlert(page: Page): Promise<string> {
  const loc = page
    .locator(".bg-red-50, p.text-red-800, p.text-red-700")
    .filter({ hasNotText: /このページを削除|削除中/ });
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible({ timeout: 0 }).catch(() => false))) continue;
    const t = ((await el.innerText().catch(() => "")) || "").trim();
    if (!t || /このページを削除|削除中/.test(t)) continue;
    return t.split("\n")[0]?.trim() || t;
  }
  return "";
}

async function ensurePaperAuthor(page: Page, state: PaperState): Promise<void> {
  const select = page.locator("#paper-author-0");
  if (!(await select.isVisible({ timeout: 0 }).catch(() => false))) {
    await select.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
  }
  if (!(await select.isVisible({ timeout: 0 }).catch(() => false))) {
    warn("著者欄が見えないのでスキップ");
    return;
  }
  const current = (await select.inputValue().catch(() => "")).trim();
  const values = await select.locator("option").evaluateAll((opts) =>
    opts.map((o) => ((o as HTMLOptionElement).value ?? "").trim()),
  );
  const choice = choosePaperAuthor({
    current,
    optionValues: values,
    filesPaste: state.filesPaste,
    title: state.title,
    filename: state.filename,
  });
  if (choice.action === "keep") {
    log(`著者（維持）: ${choice.value}`);
    return;
  }
  if (choice.action === "select") {
    await select.selectOption(choice.value);
    log(`著者: ${choice.value}`);
    return;
  }
  await select.selectOption("その他");
  await page.waitForTimeout(300);
  const other = page.getByLabel(/著者 1（その他の内容）/);
  await other.waitFor({ state: "visible", timeout: 5_000 });
  await other.fill(choice.value);
  await other.blur();
  await page.waitForTimeout(400);
  log(`著者（その他）: ${choice.value}`);
}

async function waitForEduSharePaperPage(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastAlert = "";
  while (Date.now() < deadline) {
    if (/\/tests\/[0-9a-f-]{8,}/i.test(page.url()) && !/\/upload/.test(page.url())) return;
    lastAlert = await uploadFormAlert(page);
    if (lastAlert) throw new Error(lastAlert);
    await page.waitForTimeout(500);
  }
  const leftover = lastAlert || (await uploadFormAlert(page));
  throw new Error(
    leftover
      ? leftover
      : `page.waitForURL: Timeout ${timeoutMs}ms exceeded（まだ ${page.url()}）`,
  );
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
    const paste = shouldSkipSciSpacePaste(state.filesPaste, state.filename)
      ? ""
      : eduShareSciSpaceMetadataPaste(state.filesPaste, state.filename);
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
    await ensurePaperAuthor(page, state);

    const submit = async () => {
      await page.getByRole("button", { name: "アップロードして取り込み" }).click();
    };
    await submit();
    try {
      await waitForEduSharePaperPage(page, 180_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isAuthorRequiredError(msg)) {
        log("著者が未選択だったので入れて再送信します");
        await ensurePaperAuthor(page, state);
        await submit();
        await waitForEduSharePaperPage(page, 180_000);
      } else {
        throw e;
      }
    }
    state.eduShareTestUrl = page.url();
    const m = page.url().match(/\/tests\/([0-9a-f-]{8,})/i);
    const newId = m?.[1] ?? "";
    if (newId) {
      if (bindEduSharePaper(state, newId, page.url())) {
        log("Edu Share: 論文 ID が変わったので資料を載せ直します");
      }
    } else {
      state.eduShareTestId = "";
    }
    log(`Edu Share 論文ページ: ${state.eduShareTestUrl}`);
    markCompleted(state, "edu-upload");
  } catch (e) {
    await saveFailureShot(page, paperDir, "edushare-upload");
    throw e;
  }
}

async function expandSection(page: Page, heading: string): Promise<void> {
  const box = paperSection(page, heading);
  await box.scrollIntoViewIfNeeded().catch(() => undefined);
  const closeBtn = box.getByRole("button", { name: "閉じる" });
  if (await closeBtn.isVisible({ timeout: 0 }).catch(() => false)) return;
  const edit = box.getByRole("button", { name: "編集する" });
  if (await edit.isVisible({ timeout: 0 }).catch(() => false)) {
    await edit.click({ timeout: 5_000 });
    await closeBtn.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
  }
}

async function fillReactControl(loc: Locator, value: string, label: string): Promise<boolean> {
  if (!(await loc.first().isVisible({ timeout: 0 }).catch(() => false))) {
    warn(`${label} が見えないのでスキップ`);
    return false;
  }
  const ok = await loc
    .first()
    .evaluate((el, text) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
      el.focus();
      const proto = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype,
        "value",
      );
      if (proto?.set) proto.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === text;
    }, value)
    .catch(() => false);
  if (ok) return true;
  if (!value.trim()) return false;
  return fillIfVisible(loc, value, label);
}

async function saveExternalUrlOnEduShare(
  page: Page,
  state: PaperState,
  opts: {
    heading: "NotebookLM" | "SciSpace";
    url: string;
    dataField: string;
    logLabel: string;
  },
): Promise<void> {
  if (!state.eduShareTestUrl || !opts.url) return;
  const onPaper =
    /\/tests\//.test(page.url()) &&
    Boolean(state.eduShareTestId) &&
    page.url().includes(state.eduShareTestId);
  if (!onPaper) {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
  }
  const box = paperSection(page, opts.heading);
  await expandSection(page, opts.heading);
  const urlInput = box.locator(
    `input[data-field="${opts.dataField}"], input[placeholder*="${opts.heading === "NotebookLM" ? "notebook" : "scispace"}"]`,
  );
  if (!(await urlInput.first().isVisible({ timeout: 0 }).catch(() => false))) {
    await expandSection(page, opts.heading);
  }
  await urlInput.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
  const filled = await fillReactControl(urlInput, opts.url, opts.logLabel);
  if (!filled) {
    warn(`${opts.logLabel} 欄を開けません url=${page.url().slice(0, 80)}`);
    if (state.eduShareTestId) {
      const field =
        opts.dataField === "notebooklm-notebook-url"
          ? "notebooklm_notebook_url"
          : "scispace_project_url";
      const ok = await patchEduShareJson(page, state.eduShareTestId, { [field]: opts.url });
      if (ok) log(`Edu Share: ${opts.logLabel}を API で保存 ${opts.url}`);
    }
    return;
  }
  await box.getByRole("button", { name: "リンクを保存" }).click({ timeout: 8_000 });
  const saved = await box
    .getByText("保存しました。")
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!saved && state.eduShareTestId) {
    const field =
      opts.dataField === "notebooklm-notebook-url"
        ? "notebooklm_notebook_url"
        : "scispace_project_url";
    const ok = await patchEduShareJson(page, state.eduShareTestId, { [field]: opts.url });
    if (ok) {
      log(`Edu Share: ${opts.logLabel}を API で保存 ${opts.url}`);
      return;
    }
  }
  await page.waitForTimeout(400);
  log(`Edu Share: ${opts.logLabel}を保存 ${opts.url}`);
}

export async function saveSciSpaceUrlOnEduShare(page: Page, state: PaperState): Promise<void> {
  await saveExternalUrlOnEduShare(page, state, {
    heading: "SciSpace",
    url: state.scispaceUrl,
    dataField: "scispace-project-url",
    logLabel: "SciSpace 個別リンク",
  });
}

function paperSection(page: Page, heading: string) {
  return page
    .locator("section, div.rounded-lg")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) })
    .last();
}

function parseSummarizeEvaluate(raw: unknown): {
  ok?: boolean;
  body?: { summary?: string; error?: string };
  summary?: string;
} {
  if (raw && typeof raw === "object") return raw as { ok?: boolean; body?: { summary?: string; error?: string }; summary?: string };
  try {
    return JSON.parse(String(raw || "{}")) as {
      ok?: boolean;
      body?: { summary?: string; error?: string };
      summary?: string;
    };
  } catch {
    return {};
  }
}

async function fillReactTextarea(loc: Locator, value: string, label: string): Promise<boolean> {
  return fillReactControl(loc, value.slice(0, 2000), label);
}

async function patchEduShareJson(
  page: Page,
  testId: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const path = `/api/tests/${testId}`;
  const raw = await page
    .evaluate(
      async (args: { path: string; body: Record<string, unknown> }) => {
        const res = await fetch(args.path, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args.body),
        });
        const text = await res.text();
        try {
          return JSON.stringify({ ok: res.ok, status: res.status, body: JSON.parse(text) });
        } catch {
          return JSON.stringify({
            ok: res.ok,
            status: res.status,
            body: { error: text.slice(0, 200) },
          });
        }
      },
      { path, body },
    )
    .catch((e) => JSON.stringify({ ok: false, body: { error: String(e) } }));
  const parsed = parseSummarizeEvaluate(raw);
  return Boolean(parsed.ok);
}

async function patchEduShareDescription(
  page: Page,
  testId: string,
  description: string | null,
): Promise<boolean> {
  const ok = await patchEduShareJson(page, testId, { description });
  if (!ok) warn("Edu Share: 説明の API 保存に失敗");
  return ok;
}

async function fillTldrFromPdfSummarize(page: Page, state: PaperState): Promise<boolean> {
  const id = (state.eduShareTestId || "").trim();
  if (!id) return false;
  log("Edu Share: PDF 要約 API で説明を作ります");
  const path = `/api/tests/${id}/summarize`;
  page.setDefaultTimeout(180_000);
  const raw = await page
    .evaluate(
      `(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 170000);
      try {
        const res = await fetch(${JSON.stringify(path)}, { method: "POST", credentials: "include", signal: ac.signal });
        const text = await res.text();
        try { return JSON.stringify({ ok: res.ok, status: res.status, body: JSON.parse(text) }); }
        catch { return JSON.stringify({ ok: res.ok, status: res.status, body: { error: text.slice(0, 200) } }); }
      } finally { clearTimeout(timer); }
    })()`,
    )
    .catch((e) => JSON.stringify({ ok: false, body: { error: String(e) } }));
  page.setDefaultTimeout(30_000);
  const parsed = parseSummarizeEvaluate(raw);
  const summary = (parsed.body?.summary || parsed.summary || "").trim();
  if (descriptionUsable(summary)) {
    state.tldr = summary.slice(0, 2000);
    log("Edu Share: PDF 要約を説明に入れました");
    return true;
  }
  warn(
    `Edu Share: PDF 要約 API が使えません（ok=${String(parsed.ok)} ${(parsed.body?.error || summary.slice(0, 60) || "不明").slice(0, 80)}）`,
  );
  return false;
}

export async function applySciSpaceMetaToPaperPage(
  page: Page,
  opts: { paperDir: string; state: PaperState },
): Promise<void> {
  const { paperDir, state } = opts;
  if (!state.eduShareTestUrl) throw new Error("Edu Share の論文 URL がありません");
  const paste = shouldSkipSciSpacePaste(state.filesPaste, state.filename)
    ? ""
    : eduShareSciSpaceMetadataPaste(state.filesPaste, state.filename);
  const rawTldr = state.tldr.trim();
  const tldr = descriptionUsable(rawTldr) ? rawTldr : stripTldrSnippetNumbers(rawTldr);
  let tldrOk = descriptionUsable(tldr);

  try {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const deadline = Date.now() + 10 * 60_000;
    let logged = false;
    while (Date.now() < deadline) {
      const url = page.url();
      const body = await pageBodyText(page);
      const onLogin = /\/auth\/login|accounts\.google/.test(url) || /ログインが必要/.test(body);
      if (onLogin) {
        await pauseIfBlocked(page, "Edu Share");
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
      if (!(await fillReactTextarea(pasteBox, paste, "論文ページ SciSpace 貼り付け"))) {
        throw new Error("SciSpace 貼り付け欄に入力できませんでした");
      }
      await sci.getByRole("button", { name: "貼り付けを反映して保存" }).click();
      const note = page.getByText(/メタ情報を保存しました|検出できませんでした|著者が未設定/);
      await note.first().waitFor({ timeout: 60_000 });
      const text = ((await note.first().innerText().catch(() => "")) || "").trim();
      if (/検出できませんでした|著者が未設定|失敗/.test(text)) {
        warn(`SciSpace 貼り付けは入れましたが、項目への反映はしませんでした: ${text}`);
      } else {
        log("Edu Share: メタ情報（タイトル・年著者・掲載・DOI）を保存");
      }
    }

    const info = paperSection(page, "資料情報");
    await info.scrollIntoViewIfNeeded();
    if (!(await info.getByRole("button", { name: "閉じる" }).isVisible().catch(() => false))) {
      await info.getByRole("button", { name: "編集する" }).click();
      await page.waitForTimeout(500);
    }
    const descBox = info.locator("label").filter({ hasText: "説明" }).locator("textarea");
    await descBox.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
    const wantTitle = usableEduShareTitle(state);
    if (wantTitle) {
      await fillReactControl(
        info.locator("label").filter({ hasText: "タイトル" }).locator("input"),
        wantTitle,
        "資料情報のタイトル",
      );
    }
    const wantVenue = usableEduShareVenue(state);
    if (wantVenue) {
      await fillReactControl(
        info.locator("label").filter({ hasText: /^掲載/ }).locator("input"),
        wantVenue,
        "資料情報の掲載",
      );
    }
    if (state.doi.trim()) {
      await fillReactControl(
        info.locator("label").filter({ hasText: /^DOI/ }).locator("input"),
        state.doi.trim().slice(0, 200),
        "資料情報の DOI",
      );
    }
    const wantYear = usableEduShareYear(state);
    if (wantYear) {
      if (await ensureYearPicklist(page, wantYear)) {
        const yearSel = page.locator("#paper-year");
        if (await yearSel.isVisible({ timeout: 0 }).catch(() => false)) {
          await yearSel.selectOption(wantYear).catch(() => undefined);
        }
      } else {
        warn(`発表年 ${wantYear} を候補に追加できませんでした`);
      }
    }
    await ensureIndustry(page, [state.title, state.venue, tldr].filter(Boolean).join("\n"));
    await ensurePaperAuthor(page, state);
    if (!tldrOk && (await fillTldrFromPdfSummarize(page, state))) {
      tldrOk = true;
    }
    if (!tldrOk) {
      const sumBtn = page.getByRole("button", { name: /PDF内容を要約|要約中/ });
      if (await sumBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
        log("Edu Share: SciSpace の TL;DR が無いので PDF を要約します");
        await sumBtn.first().click();
        const until = Date.now() + 180_000;
        while (Date.now() < until) {
          const v = ((await descBox.inputValue().catch(() => "")) || "").trim();
          if (descriptionUsable(v)) {
            state.tldr = v.slice(0, 2000);
            tldrOk = true;
            log("Edu Share: PDF 要約を説明に入れました");
            break;
          }
          await page.waitForTimeout(1500);
        }
        if (!descriptionUsable(state.tldr)) warn("Edu Share: PDF 要約が説明欄に入りませんでした");
      } else {
        warn("Edu Share: PDF内容を要約ボタンが見つかりません");
      }
    }
    const desc = (tldrOk ? state.tldr.trim() || tldr : tldr).slice(0, 2000);
    if (descriptionUsable(desc)) {
      const filled = await fillReactTextarea(descBox, desc, "資料情報の説明");
      if (!filled) warn("Edu Share: 説明欄に入力できませんでした");
      else state.tldr = desc;
    } else {
      const current = ((await descBox.inputValue().catch(() => "")) || "").trim();
      if (current && !descriptionUsable(current)) {
        log("Edu Share: 説明欄の画面文言を消します");
        await fillReactTextarea(descBox, "", "資料情報の説明");
        state.tldr = "";
      }
    }
    await info.getByRole("button", { name: "変更を保存" }).click();
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      if (await info.getByRole("button", { name: "編集する" }).isVisible().catch(() => false)) break;
      const err = ((await page.getByRole("alert").first().innerText().catch(() => "")) || "").trim();
      if (err) throw new Error(`資料情報の保存失敗: ${err}`);
      await page.waitForTimeout(400);
    }
    log(`Edu Share: 資料情報（説明・業界）を保存${descriptionUsable(state.tldr) ? "" : "（説明は空）"}`);
    const testId = (state.eduShareTestId || "").trim();
    if (testId) {
      const want = descriptionUsable(state.tldr) ? state.tldr.slice(0, 2000) : null;
      if (await patchEduShareDescription(page, testId, want)) {
        log(want ? "Edu Share: 説明を API で確定しました" : "Edu Share: 説明を API で空にしました");
      }
      const title = usableEduShareTitle(state);
      const venue = usableEduShareVenue(state);
      const year = usableEduShareYear(state);
      const meta: Record<string, unknown> = {};
      if (title) meta.title = title;
      if (state.doi.trim()) meta.paper_doi = state.doi.trim();
      if (venue) meta.paper_venue = venue;
      if (Object.keys(meta).length > 0) {
        if (await patchEduShareJson(page, testId, meta)) {
          log(
            `Edu Share: タイトル・掲載を API で確定しました ${[title.slice(0, 60), venue].filter(Boolean).join(" / ")}`,
          );
        }
      }
      if (year && (await ensureYearPicklist(page, year))) {
        if (await patchEduShareJson(page, testId, { publication_year: year })) {
          log(`Edu Share: 発表年を API で確定しました ${year}`);
        } else {
          warn(`Edu Share: 発表年 ${year} を API で保存できませんでした`);
        }
      }
    }
  } catch (e) {
    await saveFailureShot(page, paperDir, "edushare-scispace-meta");
    throw e;
  }
}

async function importedPoolCount(page: Page): Promise<number> {
  const body = await pageBodyText(page);
  return [...body.matchAll(/取り込み済み[（(](\d+)問[）)]/g)].filter((m) => Number(m[1]) >= 3).length;
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
  if ((await importedPoolCount(page)) >= minImported) {
    log(`Edu Share: ${successText}（既に取り込み済み）`);
    return;
  }
  const csvInputs = page.locator('input[type="file"][accept*="csv"]');
  await csvInputs.nth(inputIndex).setInputFiles(destPath);
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: buttonName }).click({ timeout: 8_000 });
  const success = page.getByText(successText);
  const alert = page.getByRole("alert");
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    if (await success.isVisible({ timeout: 0 }).catch(() => false)) {
      log(`Edu Share: ${successText}`);
      return;
    }
    if ((await importedPoolCount(page)) >= minImported) {
      log(`Edu Share: ${successText}`);
      return;
    }
    const err = ((await alert.first().innerText().catch(() => "")) || "").trim();
    if (err && !/取り込みました/.test(err)) throw new Error(`${buttonName} 失敗: ${err}`);
    await page.waitForTimeout(400);
  }
  throw new Error(`${buttonName} の完了表示が出ませんでした`);
}

function exactHeading(heading: string): RegExp {
  return new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

async function paperHasViewerMaterialPane(
  page: Page,
  heading: typeof SLIDE_MATERIAL_HEADING | typeof VIDEO_MATERIAL_HEADING,
): Promise<boolean> {
  const showBtn = page.getByRole("button", { name: materialCarouselShowLabel(heading), exact: true });
  if (await showBtn.count()) return true;
  if (heading === SLIDE_MATERIAL_HEADING) {
    if (await page.locator('iframe[title$="（スライド PDF）"]').count()) return true;
  } else if (await page.locator('video[title$="（動画）"]').count()) {
    return true;
  }
  // カルーセル見出しは span。編集フォームの見出しは p。
  return (await page.locator("span").filter({ hasText: exactHeading(heading) }).count()) > 0;
}

async function paperHasRegisteredMaterial(
  page: Page,
  heading: typeof SLIDE_MATERIAL_HEADING | typeof VIDEO_MATERIAL_HEADING,
): Promise<boolean> {
  const hasViewerPane = await paperHasViewerMaterialPane(page, heading);
  const formBlock = page.locator("p").filter({ hasText: exactHeading(heading) }).locator("xpath=..");
  const formText = (await formBlock.first().innerText({ timeout: 8_000 }).catch(() => "")).trim();
  return paperMaterialIsRegistered({ formBlockText: formText, hasViewerPane });
}

async function paperHasRegisteredSlide(page: Page): Promise<boolean> {
  return paperHasRegisteredMaterial(page, SLIDE_MATERIAL_HEADING);
}

async function paperHasRegisteredVideo(page: Page): Promise<boolean> {
  return paperHasRegisteredMaterial(page, VIDEO_MATERIAL_HEADING);
}

async function ingestStatusText(page: Page): Promise<string> {
  return (
    await page
      .locator("span.rounded-full")
      .filter({ hasText: /^(pending|processing|ready|failed)$/i })
      .first()
      .innerText({ timeout: 4_000 })
      .catch(() => "")
  ).trim();
}

async function postEduShareSlideApi(page: Page, testId: string, dest: string): Promise<void> {
  const origin = new URL(page.url()).origin;
  const buf = readFileSync(dest);
  log(`Edu Share: スライド API で登録します（${buf.length} bytes）`);
  const res = await page.request.post(`${origin}/api/tests/${testId}/material/slide`, {
    multipart: {
      file: {
        name: dest.split("/").pop() || "slides.pdf",
        mimeType: "application/pdf",
        buffer: buf,
      },
    },
    timeout: 120_000,
  });
  if (!res.ok()) {
    const text = (await res.text().catch(() => "")).slice(0, 400);
    throw new Error(`Edu Share スライド API ${res.status()}: ${text || "(空)"}`);
  }
}

async function postEduShareVideoApi(page: Page, testId: string, dest: string): Promise<void> {
  const origin = new URL(page.url()).origin;
  const buf = readFileSync(dest);
  log(`Edu Share: 動画 API で登録します（${buf.length} bytes）`);
  const res = await page.request.post(`${origin}/api/tests/${testId}/material/video`, {
    multipart: {
      file: {
        name: dest.split("/").pop() || "video.mp4",
        mimeType: "video/mp4",
        buffer: buf,
      },
    },
    timeout: 120_000,
  });
  if (!res.ok()) {
    const text = (await res.text().catch(() => "")).slice(0, 400);
    throw new Error(`Edu Share 動画 API ${res.status()}: ${text || "(空)"}`);
  }
}

export async function attachEduShareSlide(page: Page, state: PaperState): Promise<boolean> {
  if (!state.eduShareTestUrl || !state.slidePdfPath || !existsSync(state.slidePdfPath)) return false;
  const dest = state.slidePdfPath;
  const onPaper =
    /\/tests\//.test(page.url()) &&
    Boolean(state.eduShareTestId) &&
    page.url().includes(state.eduShareTestId);
  if (!onPaper) {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
  }
  await expandSection(page, "NotebookLM");
  if (await paperHasRegisteredSlide(page)) {
    log("Edu Share: スライド PDF は登録済み");
    return true;
  }

  if (state.eduShareTestId) {
    try {
      await postEduShareSlideApi(page, state.eduShareTestId, dest);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expandSection(page, "NotebookLM");
      if (await paperHasRegisteredSlide(page)) {
        log(`Edu Share: スライド PDF を登録しました（${statSync(dest).size} bytes）`);
        return true;
      }
      warn("Edu Share: スライド API は成功したが枠が見えません。ファイル入力で再試行します");
    } catch (e) {
      warn(`Edu Share スライド API: ${e instanceof Error ? e.message : e}`);
    }
  }

  const input = page.locator("p").filter({ hasText: exactHeading(SLIDE_MATERIAL_HEADING) }).locator("xpath=..").locator(
    'input[type="file"]',
  );
  if (!(await input.count())) {
    throw new Error("Edu Share のスライド file input がありません");
  }
  log(`Edu Share: スライドファイル入力で登録します（${statSync(dest).size} bytes）`);
  await input.setInputFiles(dest);
  const ok = await page.getByText("スライド用 PDF を登録しました。").waitFor({ timeout: 120_000 }).then(() => true).catch(
    () => false,
  );
  if (!ok) {
    const msg = (await page.getByRole("alert").innerText().catch(() => "")).trim();
    throw new Error(`Edu Share のスライド登録が完了しませんでした${msg ? `: ${msg}` : "（完了表示なし）"}`);
  }
  log(`Edu Share: スライド PDF を登録しました（${statSync(dest).size} bytes）`);
  return true;
}

export async function attachEduShareVideo(page: Page, state: PaperState): Promise<boolean> {
  if (!state.eduShareTestUrl) return false;
  let dest = videoArtifactPath(state.paperDir, state.videoMp4Path);
  if (!videoFileReady(state.paperDir, dest)) {
    if (state.completed.includes("nlm-video")) {
      warn("解説動画はあるが MP4 が無いので、Edu Share への動画登録はしません");
    }
    return false;
  }
  if (statSync(dest).size > VIDEO_UPLOAD_MAX_BYTES) {
    log(`Edu Share: 動画 ${statSync(dest).size} bytes はストレージ上限超なので縮小します`);
  }
  const uploadPath = ensureUploadableVideo(dest);
  if (uploadPath !== dest) {
    log(`Edu Share: 動画を ${statSync(dest).size} → ${statSync(uploadPath).size} bytes に縮小しました`);
  }
  dest = uploadPath;
  state.videoMp4Path = dest;
  const onPaper =
    /\/tests\//.test(page.url()) &&
    Boolean(state.eduShareTestId) &&
    page.url().includes(state.eduShareTestId);
  if (!onPaper) {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
  }
  await expandSection(page, "NotebookLM");
  if (await paperHasRegisteredVideo(page)) {
    log("Edu Share: 動画 MP4 は登録済み");
    return true;
  }

  if (state.eduShareTestId) {
    try {
      await postEduShareVideoApi(page, state.eduShareTestId, dest);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expandSection(page, "NotebookLM");
      if (await paperHasRegisteredVideo(page)) {
        log(`Edu Share: 動画 MP4 を登録しました（${statSync(dest).size} bytes）`);
        return true;
      }
      warn("Edu Share: 動画 API は成功したが枠が見えません。ファイル入力で再試行します");
    } catch (e) {
      warn(`Edu Share 動画 API: ${e instanceof Error ? e.message : e}`);
    }
  }

  let input = page.locator('input[type="file"][accept*="mp4"]').first();
  if (!(await input.count())) {
    const edit = page.getByRole("heading", { name: "NotebookLM", exact: true }).locator("..").getByRole(
      "button",
      { name: "編集する" },
    );
    if (await edit.first().isVisible({ timeout: 0 }).catch(() => false)) {
      await edit.first().click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
    }
    input = page.locator('input[type="file"][accept*="mp4"]').first();
  }
  if (!(await input.count())) {
    throw new Error("Edu Share の動画 file input がありません");
  }
  await input.evaluate((el) => {
    (el as HTMLInputElement).disabled = false;
  }).catch(() => undefined);
  log(`Edu Share: 動画ファイル入力で登録します（${statSync(dest).size} bytes）`);
  await input.setInputFiles(dest);
  const success = page.getByText("動画 MP4 を登録しました。");
  const ok = await success.waitFor({ timeout: 60_000 }).then(() => true).catch(() => false);
  if (!ok) {
    const msg = (await page.getByRole("alert").innerText().catch(() => "")).trim();
    throw new Error(`Edu Share の動画登録が完了しませんでした${msg ? `: ${msg}` : "（完了表示なし）"}`);
  }
  log(`Edu Share: 動画 MP4 を登録しました（${statSync(dest).size} bytes）`);
  return true;
}

export async function runEduShareMaterials(
  page: Page,
  opts: {
    paperDir: string;
    state: PaperState;
    selected?: readonly StudioStageId[];
  },
): Promise<void> {
  const { paperDir, state } = opts;
  const selected = opts.selected ?? [];
  const uploaded = new Set(state.eduUploaded ?? []);
  const quizReady = Boolean(state.quizCsvPath && existsSync(state.quizCsvPath));
  const vocabReady = Boolean(state.vocabCsvPath && existsSync(state.vocabCsvPath));
  const slidesReady = Boolean(state.slidePdfPath && existsSync(state.slidePdfPath));
  const needQuiz = quizReady && !uploaded.has("nlm-quiz");
  const needVocab = vocabReady && !uploaded.has("nlm-flashcards");
  const needSlides = slidesReady && !uploaded.has("nlm-slides");
  const needVideo =
    videoFileReady(state.paperDir, state.videoMp4Path) && !uploaded.has("nlm-video");
  if (isCompleted(state, "edu-materials") && !needQuiz && !needVocab && !needSlides && !needVideo) {
    return;
  }
  if (!state.eduShareTestUrl) throw new Error("Edu Share の論文 URL がありません");

  try {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
    await expandSection(page, "NotebookLM");

    if (needQuiz && state.quizCsvPath) {
      await importNotebookLmCsv(
        page,
        state.quizCsvPath,
        0,
        "クイズ CSV を取り込む",
        "クイズ CSV を取り込みました。",
        1,
      );
      markEduUploaded(state, "nlm-quiz");
    }
    if (needVocab && state.vocabCsvPath) {
      await importNotebookLmCsv(
        page,
        state.vocabCsvPath,
        1,
        "単語帳 CSV を取り込む",
        "単語帳（Flashcard）CSV を取り込みました。",
        2,
      );
      markEduUploaded(state, "nlm-flashcards");
    }

    if (needSlides && (await attachEduShareSlide(page, state))) {
      markEduUploaded(state, "nlm-slides");
    }
    if (needVideo && (await attachEduShareVideo(page, state))) {
      markEduUploaded(state, "nlm-video");
    }

    if (state.notebooklmUrl) {
      await saveExternalUrlOnEduShare(page, state, {
        heading: "NotebookLM",
        url: state.notebooklmUrl,
        dataField: "notebooklm-notebook-url",
        logLabel: "NotebookLM リンク",
      });
    }

    await applySciSpaceMetaToPaperPage(page, { paperDir, state });

    await expandSection(page, "SciSpace");
    if (state.scispaceUrl) {
      await saveSciSpaceUrlOnEduShare(page, state);
    }

    const remaining = selected.length
      ? selected.filter((s) => {
          const uploadedNow = new Set(state.eduUploaded ?? []);
          return !uploadedNow.has(s);
        })
      : [];
    if (remaining.length === 0) markCompleted(state, "edu-materials");
  } catch (e) {
    await saveFailureShot(page, paperDir, "edushare-materials");
    throw e;
  }
}

export async function verifyEduSharePaper(
  page: Page,
  opts: {
    paperDir: string;
    state: PaperState;
    skipSlidesVideo?: boolean;
    studioSkip?: readonly StudioStageId[];
  },
): Promise<void> {
  const { paperDir, state, skipSlidesVideo = false } = opts;
  const skipVideo = opts.studioSkip?.includes("nlm-video") ?? skipSlidesVideo;
  const skipQuiz = opts.studioSkip?.includes("nlm-quiz") ?? false;
  const skipFlash = opts.studioSkip?.includes("nlm-flashcards") ?? false;
  if (isCompleted(state, "verify")) return;
  if (!state.eduShareTestUrl) throw new Error("Edu Share の論文 URL がありません");

  try {
    await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
    await expandSection(page, "NotebookLM");
    const quizStart = page.locator('a[href*="csvPool=quiz"]');
    const ingestStatus = await ingestStatusText(page);
    if (/^(pending|processing)$/i.test(ingestStatus)) {
      const deadline = Date.now() + 180_000;
      log(`確認: PDF 取り込み待ち（${ingestStatus}）`);
      while (Date.now() < deadline) {
        await page.waitForTimeout(4_000);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        const st = await ingestStatusText(page);
        if (/^ready$/i.test(st)) break;
      }
      await expandSection(page, "NotebookLM");
    }
    await page.getByRole("heading", { name: "資料", exact: true }).waitFor({ state: "visible", timeout: 8_000 }).catch(
      () => undefined,
    );
    await page.locator("span").filter({ hasText: /^元PDF$/ }).first().waitFor({ timeout: 5_000 }).catch(
      () => undefined,
    );

    const hasPdf =
      (await page.getByRole("button", { name: "元PDFを表示", exact: true }).count()) > 0 ||
      (await page.locator("span").filter({ hasText: /^元PDF$/ }).count()) > 0 ||
      /元PDF|新しいタブで開く/.test(await pageBodyText(page));
    if (!hasPdf) throw new Error("元 PDF の表示が見つかりません");

    const skipSlides = opts.studioSkip?.includes("nlm-slides") ?? skipSlidesVideo;
    const hasSlide = await paperHasRegisteredSlide(page);
    const hasVideo = await paperHasRegisteredVideo(page);
    const slidesLocal = Boolean(state.slidePdfPath && existsSync(state.slidePdfPath));
    const videoLocal = videoFileReady(state.paperDir, state.videoMp4Path);
    if (!hasSlide && slidesLocal && !skipSlides) {
      unmarkEduUploaded(state, "nlm-slides");
      throw new Error("Edu Share にスライド（PDF）がありません");
    }
    if (!hasVideo && videoLocal && !skipVideo) {
      unmarkEduUploaded(state, "nlm-video");
      throw new Error("Edu Share に動画（MP4）がありません");
    }
    if (!hasSlide) warn("スライドは未登録です");
    if (!hasVideo) warn("動画は未登録です");

    const csvTab = page.getByRole("tab", { name: "NotebookLM CSV" });
    if (await csvTab.isVisible({ timeout: 0 }).catch(() => false)) {
      await csvTab.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
    }
    const quizReady = Boolean(state.quizCsvPath && existsSync(state.quizCsvPath));
    const vocabReady = Boolean(state.vocabCsvPath && existsSync(state.vocabCsvPath));
    if (!skipQuiz) {
      await quizStart.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
    }

    if (!skipQuiz) {
      if (!(await quizStart.first().isVisible({ timeout: 0 }).catch(() => false))) {
        if (quizReady) {
          unmarkEduUploaded(state, "nlm-quiz");
          throw new Error("Edu Share にクイズ CSV がありません");
        }
        const take = state.eduShareTestUrl.replace(/\/$/, "") + "/take?csvPool=quiz";
        log("確認: クイズ開始ボタンが無いので CSV プール URL を開きます");
        await page.goto(take, { waitUntil: "domcontentloaded" });
      } else {
        await quizStart.first().click({ timeout: 8_000 });
      }
      await page.waitForURL(/\/tests\/.+\/take/, { timeout: 20_000 });
      await page.goto(state.eduShareTestUrl, { waitUntil: "domcontentloaded" });
    }
    if (await csvTab.isVisible({ timeout: 0 }).catch(() => false)) {
      await csvTab.click({ timeout: 5_000 }).catch(() => undefined);
    }
    if (!skipFlash) {
      const vocabAgain = page.locator('a[href*="csvPool=vocab"]');
      if (await vocabAgain.first().isVisible({ timeout: 0 }).catch(() => false)) {
        await vocabAgain.first().click({ timeout: 8_000 });
      } else if (vocabReady) {
        unmarkEduUploaded(state, "nlm-flashcards");
        throw new Error("Edu Share に単語帳 CSV がありません");
      } else {
        const take = state.eduShareTestUrl.replace(/\/$/, "") + "/take?csvPool=vocab";
        log("確認: 単語帳開始ボタンが無いので CSV プール URL を開きます");
        await page.goto(take, { waitUntil: "domcontentloaded" });
      }
      await page.waitForURL(/\/tests\/.+\/take/, { timeout: 20_000 });
    }

    log("確認: PDF/スライド/動画と CSV テスト開始まで到達");
    markCompleted(state, "verify");
  } catch (e) {
    await saveFailureShot(page, paperDir, "verify");
    throw e;
  }
}