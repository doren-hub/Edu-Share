import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { emptyState, loadState, hasStudioStarted, isCompleted, type PaperState } from "../state.ts";
import { GenerationWaitingError } from "../waiting.ts";
import { StudioQuotaReachedError } from "../notebook-quota.ts";
import {
  tryKickoffStudio,
  collectReadyStudio,
  openVideoCustomize,
  selectExplainerVideoFormat,
  clickExplainerCardOverflow,
  returnToStudioList,
  runStudioParallel,
  studioArtifactViewerOpen,
} from "./notebooklm.ts";

function makeQuizAppData(): string {
  return JSON.stringify({
    questions: [
      {
        question: "乱流の慣性小領域におけるエネルギースペクトルの指数は？",
        options: [
          { text: "-5/3", isCorrect: true },
          { text: "-2", isCorrect: false },
          { text: "-3", isCorrect: false },
          { text: "-1", isCorrect: false },
        ],
        hint: "コルモゴロフ則",
      },
      {
        question: "レイノルズ数の定義に含まれる量はどれか？",
        options: [
          { text: "動粘性係数", isCorrect: true },
          { text: "比熱比", isCorrect: false },
          { text: "誘電率", isCorrect: false },
          { text: "透磁率", isCorrect: false },
        ],
        hint: "慣性力と粘性力の比",
      },
      {
        question: "エネルギーカスケードの向き（3次元乱流）は？",
        options: [
          { text: "大スケールから小スケールへ", isCorrect: true },
          { text: "小スケールから大スケールへ", isCorrect: false },
          { text: "スケール間で移動しない", isCorrect: false },
          { text: "時間のみに依存する", isCorrect: false },
        ],
        hint: "リチャードソンの描像",
      },
    ],
  });
}

function makeFlashcardsAppData(): string {
  return JSON.stringify({
    cards: [
      { front: "レイノルズ数", back: "慣性力と粘性力の比を表す無次元数" },
      { front: "コルモゴロフスケール", back: "粘性散逸が卓越する最小渦スケール" },
      { front: "慣性小領域", back: "エネルギー注入と散逸の間で自己相似が成り立つ領域" },
    ],
  });
}

function makeFakeSlidePdfDataUrl(): string {
  const body = `%PDF-1.4\n1 0 obj<<>>endobj\n${"A".repeat(90_000)}\n%%EOF\n`;
  return `data:application/pdf;base64,${Buffer.from(body, "utf8").toString("base64")}`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function mountStudioFixture(
  page: Page,
  opts: {
    hasQuizReady?: boolean;
    hasFlashcardsReady?: boolean;
    slidesState?: "none" | "generating" | "ready";
    slideReadyToast?: boolean;
    videoState?: "none" | "generating" | "ready";
    closeVia?: "close-button" | "breadcrumb";
    videoDialog?: "dialog" | "overlay" | "heading" | "none" | "auto-generate";
    videoSelected?: boolean;
    videoSelectable?: boolean;
  },
): Promise<void> {
  const quizJson = escapeAttr(makeQuizAppData());
  const flashcardsJson = escapeAttr(makeFlashcardsAppData());
  const slidePdfDataUrl = escapeAttr(makeFakeSlidePdfDataUrl());
  const closeVia = opts.closeVia ?? "breadcrumb";

  await page.setContent(`
    <!doctype html>
    <html>
      <body style="margin:0;font-family:sans-serif">
        <div id="sources-panel" style="position:fixed;left:0;top:0;width:260px;height:800px">
          <button>ソースを追加</button>
          <div>1 件のソース</div>
          <div>turbulence-paper.pdf</div>
        </div>

        <div id="studio-panel" style="position:fixed;left:760px;top:0;width:480px;height:800px">
          <h2>Studio</h2>
          ${
            opts.slideReadyToast
              ? `<div id="slide-toast">スライド資料「高レイノルズ数乱流の統計則と構造」の準備ができました。表示 閉じる</div>`
              : ""
          }
          <div id="studio-list-view">
            <div id="creation-tiles">
              <button id="tile-audio" onclick="window.openCustomize('audio')">音声解説 chevron_forward</button>
              <div id="tile-video" role="button" aria-label="動画解説" onclick="window.openCustomize('video')">動画解説<mat-icon role="img">videocam</mat-icon></div>
              <button id="tile-slides" onclick="window.openCustomize('slides')">スライド資料 chevron_forward</button>
              <button id="tile-quiz" onclick="window.openCustomize('quiz')">クイズ chevron_forward</button>
              <button id="tile-flashcards" onclick="window.openCustomize('flashcards')">フラッシュカード chevron_forward</button>
            </div>

            <div id="artifact-list">
              ${
                opts.slidesState === "generating"
                  ? `<artifact-library-item id="card-slides" style="display:block;position:relative;width:380px;height:68px">
                      <div class="artifact-button-content">
                        <div class="artifact-primary-content" id="artifact-labels-slides">
                          <span class="artifact-icon">tablet</span>
                          <span class="artifact-title">スライド資料を生成しています...</span>
                          <span>1 件のソース</span>
                          <mat-icon>sync</mat-icon>
                        </div>
                      </div>
                    </artifact-library-item>`
                  : opts.slidesState === "ready"
                    ? `<artifact-library-item id="card-slides" style="display:block;position:relative;width:380px;height:68px">
                        <div class="artifact-button-content">
                          <button class="artifact-stretched-button" aria-labelledby="artifact-labels-slides"
                            onclick="window.openViewer('slides')"
                            style="position:absolute;inset:0;width:100%;height:100%;z-index:2"></button>
                          <div class="artifact-primary-content" id="artifact-labels-slides">
                            <span class="artifact-icon">tablet</span>
                            <span class="artifact-title">高レイノルズ数乱流の統計則と構造</span>
                            <span>1 件のソース · 2 分前</span>
                          </div>
                        </div>
                      </artifact-library-item>`
                    : ""
              }

              ${
                opts.videoState === "generating"
                  ? `<artifact-library-item id="card-video" style="display:block;position:relative;width:380px;height:68px">
                      <div class="artifact-button-content">
                        <div class="artifact-primary-content" id="artifact-labels-video">
                          <span class="artifact-icon">videocam</span>
                          <span class="artifact-title">動画解説を生成しています...</span>
                          <span>1 件のソース</span>
                          <mat-icon>sync</mat-icon>
                        </div>
                      </div>
                    </artifact-library-item>`
                  : opts.videoState === "ready"
                    ? `<artifact-library-item id="card-video" style="display:block;position:relative;width:380px;height:68px">
                        <div class="artifact-button-content">
                          <button class="artifact-stretched-button" aria-labelledby="artifact-labels-video"
                            style="position:absolute;inset:0;width:100%;height:100%;z-index:2"></button>
                          <div class="artifact-primary-content" id="artifact-labels-video">
                            <span class="artifact-icon">videocam</span>
                            <span class="artifact-title">乱流の解説動画</span>
                            <span>6:42 · 解説 · 1 件のソース · 3 分前</span>
                          </div>
                        </div>
                      </artifact-library-item>`
                    : ""
              }

              ${
                opts.hasQuizReady
                  ? `<artifact-library-item id="card-quiz" style="display:block;position:relative;width:380px;height:68px">
                      <div class="artifact-button-content">
                        <button class="artifact-stretched-button" aria-labelledby="artifact-labels-quiz"
                          onclick="window.openViewer('quiz')"
                          style="position:absolute;inset:0;width:100%;height:100%;z-index:2"></button>
                        <div class="artifact-primary-content" id="artifact-labels-quiz">
                          <span class="artifact-icon">quiz</span>
                          <span class="artifact-title">高レイノルズ数乱流 クイズ</span>
                          <span>1 件のソース · 4 分前</span>
                        </div>
                      </div>
                    </artifact-library-item>`
                  : ""
              }

              ${
                opts.hasFlashcardsReady
                  ? `<artifact-library-item id="card-flashcards" style="display:block;position:relative;width:380px;height:68px">
                      <div class="artifact-button-content">
                        <button class="artifact-stretched-button" aria-labelledby="artifact-labels-flashcards"
                          onclick="window.openViewer('flashcards')"
                          style="position:absolute;inset:0;width:100%;height:100%;z-index:2"></button>
                        <div class="artifact-primary-content" id="artifact-labels-flashcards">
                          <span class="artifact-icon">copy</span>
                          <span class="artifact-title">高レイノルズ数乱流 暗記カード</span>
                          <span>1 件のソース · 3 分前</span>
                        </div>
                      </div>
                    </artifact-library-item>`
                  : ""
              }
            </div>
          </div>

          <div id="studio-viewer-view" style="display:none">
            <div class="viewer-header">
              <span>dock_to_left</span>
              ${
                closeVia === "breadcrumb"
                  ? `<button id="viewer-breadcrumb" onclick="window.closeViewer()">アプリ</button><span>chevron_right</span>`
                  : `<span>アプリ</span><span>chevron_right</span><button id="viewer-close" onclick="window.closeViewer()">collapse_content</button>`
              }
              <button>適切なコンテンツ</button>
              <button>不適切なコンテンツ</button>
            </div>
            <div id="viewer-body"></div>
          </div>
        </div>

        <div id="customize-dialog" ${opts.videoDialog === "heading" ? "" : opts.videoDialog === "overlay" ? 'class="cdk-overlay-pane"' : 'role="dialog"'} style="display:none;position:fixed;left:400px;top:200px;width:420px;height:280px;background:#fff;z-index:10">
          <div id="customize-title">Studio をカスタマイズ</div>
          <button id="format-short" aria-pressed="${!opts.videoSelected}" onclick="this.setAttribute('aria-pressed','true');document.getElementById('format-explainer').setAttribute('aria-pressed','false')">短め</button>
          <button id="format-explainer" aria-pressed="${!!opts.videoSelected}" onclick="${opts.videoSelectable === false ? "" : "this.setAttribute('aria-pressed','true');document.getElementById('format-short').setAttribute('aria-pressed','false');document.body.dataset.format='explainer'"}">説明動画</button>
          <button onclick="document.body.dataset.format='presenter'">プレゼンターのスライド</button>
          <button onclick="document.body.dataset.later='true'">後で生成</button>
          <button id="btn-generate-now" onclick="window.confirmGenerate()">生成</button>
          <button onclick="window.closeCustomize()">閉じる</button>
        </div>

        <script>
          window.__quizAppData = "${quizJson}";
          window.__flashcardsAppData = "${flashcardsJson}";
          window.__slidePdfUrl = "${slidePdfDataUrl}";
          window.__kickedOff = [];
          window.__openCount = { quiz: 0, flashcards: 0, slides: 0 };

          window.openViewer = function(kind) {
            window.__openCount[kind] = (window.__openCount[kind] || 0) + 1;
            document.getElementById('studio-list-view').style.display = 'none';
            const v = document.getElementById('studio-viewer-view');
            const body = document.getElementById('viewer-body');
            v.style.display = 'block';
            if (kind === 'quiz') {
              body.innerHTML = '<app-root data-app-data="' + window.__quizAppData + '"><div>クイズ 1 / 3</div></app-root>';
            } else if (kind === 'flashcards') {
              body.innerHTML = '<app-root data-app-data="' + window.__flashcardsAppData + '"><div>カード 1 / 3</div></app-root>';
            } else if (kind === 'slides') {
              body.innerHTML = '<iframe src="' + window.__slidePdfUrl + '"></iframe>';
            }
          };

          window.closeViewer = function() {
            const v = document.getElementById('studio-viewer-view');
            const body = document.getElementById('viewer-body');
            v.style.display = 'none';
            body.innerHTML = '';
            document.getElementById('studio-list-view').style.display = 'block';
          };

          window.openCustomize = function(stage) {
            document.body.dataset.pendingStage = stage;
            if (stage === 'video' && '${opts.videoDialog}' === 'none') return;
            if (stage === 'video' && '${opts.videoDialog}' === 'auto-generate') { window.confirmGenerate(); return; }
            document.getElementById('customize-title').textContent = stage === 'video' ? '動画解説をカスタマイズ' : 'Studio をカスタマイズ';
            document.getElementById('customize-dialog').style.display = 'block';
          };

          window.closeCustomize = function() {
            document.getElementById('customize-dialog').style.display = 'none';
          };

          window.confirmGenerate = function() {
            const stage = document.body.dataset.pendingStage || '';
            window.__kickedOff.push(stage);
            document.getElementById('customize-dialog').style.display = 'none';
            const list = document.getElementById('artifact-list');
            const icon = stage === 'video' ? 'videocam' : stage === 'slides' ? 'tablet' : stage === 'quiz' ? 'quiz' : 'copy';
            const label = stage === 'video' ? '動画解説を生成しています...' : stage === 'slides' ? 'スライド資料を生成しています...' : '生成しています...';
            const item = document.createElement('artifact-library-item');
            item.style.cssText = 'display:block;position:relative;width:380px;height:68px';
            item.innerHTML = '<div class="artifact-button-content"><div class="artifact-primary-content"><span class="artifact-icon">' + icon + '</span><span class="artifact-title">' + label + '</span><span>1 件のソース</span><mat-icon>sync</mat-icon></div></div>';
            list.prepend(item);
          };
        </script>
      </body>
    </html>
  `);
}

/** Fixed Material DOM from issue 318: native input and tile label are siblings. */
async function mountMaterialVideoFixture(page: Page, selected: boolean, label = "説明動画"): Promise<void> {
  await mountStudioFixture(page, {});
  await page.locator("#customize-dialog").evaluate((el, { selected, label }) => {
    el.outerHTML = `
      <mat-dialog-container id="customize-dialog" role="dialog" style="display:none;position:fixed;left:400px;top:100px;width:420px;background:white;z-index:10">
        <h2 id="customize-title" class="dialog-title-text">動画解説をカスタマイズ</h2>
        <button aria-label="ダイアログを閉じる" onclick="window.closeCustomize()">×</button>
        <label class="control-label" id="templateFormat-label">形式</label>
        <mat-radio-group role="radiogroup" aria-labelledby="templateFormat-label">
          <mat-radio-button class="mat-mdc-radio-button tile-radio-button ${selected ? "" : "mat-mdc-radio-checked"}">
            <label class="mdc-form-field" for="mat-radio-0-input">
              <span class="mdc-radio"><input type="radio" class="mdc-radio__native-control" id="mat-radio-0-input" name="format" value="4" ${selected ? "" : "checked"}></span>
              <span class="mdc-label"><div class="tile-content"><span class="tile-label">短め</span>
                <div class="tile-tag">新機能！</div><p class="tile-description">ソースの概要を短くまとめ、要点をすばやく把握できます</p>
              </div></span>
            </label>
          </mat-radio-button>
          <mat-radio-button id="material-explainer" class="mat-mdc-radio-button tile-radio-button ${selected ? "mat-mdc-radio-checked" : ""}">
            <label class="mdc-form-field" for="mat-radio-1-input">
              <span class="mdc-radio"><input type="radio" class="mdc-radio__native-control" id="mat-radio-1-input" name="format" value="1" ${selected ? "checked" : ""}></span>
              <span class="mdc-label"><div class="tile-content"><span class="tile-label">${label}</span>
                <p class="tile-description">ソース内の情報を結びつける、構造化された包括的な概要です</p>
              </div></span>
            </label>
          </mat-radio-button>
        </mat-radio-group>
        <label id="videoOverviewStyle-label">ビジュアル スタイル</label>
        <mat-radio-group role="radiogroup" aria-labelledby="videoOverviewStyle-label">
          <mat-radio-button><label><input id="style-radio" type="radio" name="style" checked><span class="tile-label">説明動画</span></label></mat-radio-button>
          <button aria-pressed="false" onclick="document.body.dataset.styleTouched='true'">Explainer</button>
        </mat-radio-group>
        <mat-dialog-actions>
          <button onclick="document.body.dataset.later='true'">後で生成</button>
          <button id="btn-generate-now" onclick="document.body.dataset.generatedFormat=document.getElementById('mat-radio-1-input')?.checked ? 'explainer' : 'short';window.confirmGenerate()">生成</button>
        </mat-dialog-actions>
      </mat-dialog-container>`;
  }, { selected, label });
}

function makeTempState(partial: Partial<PaperState> = {}): { paperDir: string; state: PaperState } {
  const paperDir = mkdtempSync(join(tmpdir(), "pp-nlm-studio-"));
  const inboxPdfPath = join(paperDir, "input.pdf");
  writeFileSync(inboxPdfPath, "%PDF-1.4 dummy");
  const state: PaperState = {
    ...emptyState({
      filename: "input.pdf",
      inboxPdfPath,
      paperDir,
    }),
    completed: ["sci-upload", "nlm-create", "nlm-upload"],
    ...partial,
  };
  return { paperDir, state };
}

test("NotebookLM Studio viewer return and stage transitions", async (t) => {
  const browser = await chromium.launch().catch(async (e) => {
    if (!String(e).includes("Executable doesn't exist")) throw e;
    return chromium.launch({ channel: "chrome" });
  });
  const context = await browser.newContext();
  await context.route(/^https?:\/\//, route => route.abort());
  await context.newPage(); // keeper tab so ensureKeeperTab is a no-op

  try {
    await t.test("後で生成だけなら失敗回数を増やさず、残りの Studio も開始しない", async () => {
      const page = await context.newPage();
      const { paperDir, state } = makeTempState({ kickoffFailures: { "nlm-slides": 2 } });
      try {
        await mountStudioFixture(page, {});
        await page.locator("#btn-generate-now").evaluate(el => el.remove());
        await assert.rejects(
          runStudioParallel(page, paperDir, state, [], false, { outputReadyTimeoutMs: 100 }),
          StudioQuotaReachedError,
        );
        assert.deepEqual(state.kickoffFailures, { "nlm-slides": 2 });
        assert.equal(state.kickoffRetryStage, "");
        assert.equal(state.giveUp, undefined);
        assert.deepEqual(await page.evaluate(() => Reflect.get(window, "__kickedOff")), []);
        assert.equal(await page.getAttribute("body", "data-pending-stage"), "slides");
        assert.equal(await page.getAttribute("body", "data-later"), null);
      } finally { await page.close(); rmSync(paperDir, { recursive: true, force: true }); }
    });

    await t.test("動画の形式選択より先に Generate later だけの表示を区別する", async () => {
      const page = await context.newPage();
      const { paperDir, state } = makeTempState({ kickoffFailures: { "nlm-video": 2 } });
      try {
        await mountStudioFixture(page, { videoDialog: "heading", videoSelectable: false });
        await page.locator("#btn-generate-now").evaluate(el => el.remove());
        await page.locator("#customize-dialog button").filter({ hasText: "後で生成" })
          .evaluate(el => { el.textContent = "Generate later"; });
        await assert.rejects(
          tryKickoffStudio(page, state, "nlm-video", [/動画解説/], 100, { explainerVideo: true }),
          StudioQuotaReachedError,
        );
        assert.deepEqual(state.kickoffFailures, { "nlm-video": 2 });
        assert.equal(state.giveUp, undefined);
        assert.equal(await page.getAttribute("body", "data-later"), null);
      } finally { await page.close(); rmSync(paperDir, { recursive: true, force: true }); }
    });

    await t.test("開始失敗は永続化し、開始済みにせず3回で打ち切る", async () => {
      const page = await context.newPage();
      const { paperDir, state: initial } = makeTempState();
      try {
        await mountStudioFixture(page, { videoSelectable: false });
        let state = initial;
        for (let i = 1; i <= 3; i++) {
          state.kickoffRetryAt = "";
          const kick = () => tryKickoffStudio(page, state, "nlm-video", [/動画解説/], 100, { explainerVideo: true });
          if (i < 3) assert.equal(await kick(), "skipped");
          else await assert.rejects(kick, /開始失敗が 3 回/);
          state = loadState(paperDir, initial);
          assert.equal(state.kickoffFailures?.["nlm-video"], i);
          assert.equal(hasStudioStarted(state, "nlm-video"), false);
          assert.equal(state.generationStartedAt, "");
          if (i < 3) {
            assert.equal(await kick(), "skipped"); // cooling does not count another failure
            assert.equal(state.kickoffFailures?.["nlm-video"], i);
          }
        }
        assert.ok(state.giveUp);
        assert.equal(await page.getAttribute("body", "data-unsafe-generation"), null);
      } finally { await page.close(); rmSync(paperDir, { recursive: true, force: true }); }
    });

    for (const mode of ["dialog", "overlay", "heading"] as const) {
      for (const selected of [false, true]) {
        await t.test(`タイルから ${mode} を開き、説明動画の選択を確認して生成（選択済み=${selected}）`, async () => {
          const page = await context.newPage();
          const { paperDir, state } = makeTempState();
          try {
            await mountStudioFixture(page, { videoDialog: mode, videoSelected: selected });
            assert.equal(await tryKickoffStudio(page, state, "nlm-video", [/動画解説/], 100,
              { explainerVideo: true, kickoffConfirmMs: 1 }), "started");
            assert.equal(await page.locator("#format-explainer").getAttribute("aria-pressed"), "true");
            assert.equal(await page.locator("#format-short").getAttribute("aria-pressed"), "false");
            assert.deepEqual(await page.evaluate(() => (window as unknown as { __kickedOff: string[] }).__kickedOff), ["video"]);
            assert.equal(await page.getAttribute("body", "data-later"), null);
            // Already selected controls must not be toggled off by a gratuitous click.
            assert.equal(await page.getAttribute("body", "data-format"), selected ? null : "explainer");
          } finally { await page.close(); rmSync(paperDir, { recursive: true, force: true }); }
        });
      }
    }

    for (const label of ["説明動画", "解説", "Explainer"]) {
      for (const selected of [false, true]) {
        await t.test(`実画面のMaterialラジオで${label}を確認して生成（初期選択=${selected}）`, async () => {
          const page = await context.newPage();
          const { paperDir, state } = makeTempState();
          try {
            await mountMaterialVideoFixture(page, selected, label);
            assert.equal(await tryKickoffStudio(page, state, "nlm-video", [/動画解説/], 100,
              { explainerVideo: true, kickoffConfirmMs: 1 }), "started");
            assert.equal(await page.locator("#mat-radio-1-input").isChecked(), true);
            assert.equal(await page.locator("#mat-radio-0-input").isChecked(), false);
            assert.equal(await page.getAttribute("body", "data-generated-format"), "explainer");
            assert.equal(await page.locator("#style-radio").isChecked(), true);
            assert.equal(await page.getAttribute("body", "data-style-touched"), null);
            assert.equal(await page.getAttribute("body", "data-later"), null);
          } finally { await page.close(); rmSync(paperDir, { recursive: true, force: true }); }
        });
      }
    }

    for (const failure of ["disabled", "stale-class", "missing-input", "missing-format"] as const) {
      await t.test(`実画面のMaterialラジオで選択未確認なら生成しない: ${failure}`, async () => {
        const page = await context.newPage();
        const { paperDir, state } = makeTempState();
        try {
          await mountMaterialVideoFixture(page, false);
          await page.locator("#material-explainer").evaluate((el, failure) => {
            if (failure === "missing-format") {
              el.closest("mat-radio-group")!.remove();
              return;
            }
            el.querySelector("input")!.disabled = true;
            if (failure === "stale-class" || failure === "missing-input") el.classList.add("mat-mdc-radio-checked");
            if (failure === "missing-input") el.querySelector("input")!.remove();
          }, failure);
          assert.equal(await tryKickoffStudio(page, state, "nlm-video", [/動画解説/], 100,
            { explainerVideo: true, kickoffConfirmMs: 1 }), "skipped");
          assert.equal(await page.getAttribute("body", "data-generated-format"), null);
          assert.equal(await page.getAttribute("body", "data-style-touched"), null);
          assert.equal(await page.getAttribute("body", "data-later"), null);
          assert.equal(await page.locator("#style-radio").isChecked(), true);
          assert.equal(await page.locator("#customize-dialog").isVisible(), false);
          assert.equal(loadState(paperDir, state).kickoffFailures?.["nlm-video"], 1);
        } finally { await page.close(); rmSync(paperDir, { recursive: true, force: true }); }
      });
    }

    for (const scenario of ["many-candidates", "delayed-selection", "disabled-click", "disappearing"] as const) {
      await t.test(`形式選択の期限後に後続画面を操作しない: ${scenario}`, async () => {
        const page = await context.newPage();
        try {
          await mountStudioFixture(page, {});
          assert.equal(await openVideoCustomize(page), true);
          await page.locator("#format-explainer").evaluate((el, scenario) => {
            document.body.dataset.selectionClicks = "0";
            document.getElementById("customize-dialog")!.style.overflow = "auto";
            el.outerHTML = Array.from({ length: scenario === "many-candidates" ? 100 : 1 }, (_, index) => `<button aria-pressed="false" ${scenario === "disabled-click" ? "disabled" : ""}
              onclick="document.body.dataset.selectionClicks=String(Number(document.body.dataset.selectionClicks)+1);
              ${scenario === "delayed-selection" ? "setTimeout(() => this.setAttribute('aria-pressed','true'), 800)" : ""}">Explainer ${index}</button>`).join("");
            if (scenario === "disappearing") {
              // Present during discovery but gone while Playwright waits to click.
              const button = document.querySelector('#customize-dialog button[aria-pressed="false"]:not(#format-short)')!;
              button.setAttribute("disabled", "");
              setTimeout(() => button.remove(), 100);
            }
          }, scenario);
          const started = performance.now();
          await assert.rejects(() => selectExplainerVideoFormat(page, 400), /タイムアウト|Timeout/);
          assert.ok(performance.now() - started < 2_000, "selection plus awaited cleanup must be bounded");
          assert.equal(await page.locator("#customize-dialog").isVisible(), false);
          assert.equal(await page.getAttribute("body", "data-later"), null);
          assert.deepEqual(await page.evaluate(() => (window as unknown as { __kickedOff: string[] }).__kickedOff), []);
          const clicks = await page.getAttribute("body", "data-selection-clicks");
          if (scenario === "many-candidates" || scenario === "delayed-selection") assert.equal(clicks, "1");
          else assert.equal(clicks, "0");
          // The caller starts its next operation immediately after rejection.
          await page.locator("#customize-dialog").evaluate(el => { (el as HTMLElement).style.display = "block"; });
          await page.waitForTimeout(1_200);
          assert.equal(await page.locator("#customize-dialog").isVisible(), true);
          assert.equal(await page.getAttribute("body", "data-selection-clicks"), clicks);
          assert.equal(await page.getAttribute("body", "data-later"), null);
          assert.deepEqual(await page.evaluate(() => (window as unknown as { __kickedOff: string[] }).__kickedOff), []);
        } finally { await page.close(); }
      });
    }

    await t.test("期限内の遅延選択は確認して成功する", async () => {
      const page = await context.newPage();
      try {
        await mountStudioFixture(page, {});
        assert.equal(await openVideoCustomize(page), true);
        await page.locator("#format-explainer").evaluate(el => {
          el.setAttribute("onclick", "setTimeout(() => this.setAttribute('aria-pressed','true'), 100)");
        });
        await selectExplainerVideoFormat(page, 2_000);
        assert.equal(await page.locator("#format-explainer").getAttribute("aria-pressed"), "true");
        assert.equal(await page.locator("#customize-dialog").isVisible(), true);
      } finally { await page.close(); }
    });

    for (const role of ["radio", "option", "tab", "text"] as const) {
      await t.test(`形式選択の ${role} と選択属性を検証`, async () => {
        const page = await context.newPage();
        try {
          await mountStudioFixture(page, {});
          await page.locator("#format-explainer").evaluate((el, role) => {
            const attr = role === "radio" ? "aria-checked" : "aria-selected";
            el.outerHTML = `<div id="format-explainer" ${role === "text" ? "" : `role="${role}"`} ${attr}="false"
              onclick="this.setAttribute('${attr}', 'true')"><span>Explainer</span></div>`;
          }, role);
          assert.equal(await openVideoCustomize(page), true);
          await selectExplainerVideoFormat(page);
          assert.equal(await page.locator("#format-explainer").getAttribute(role === "radio" ? "aria-checked" : "aria-selected"), "true");
        } finally { await page.close(); }
      });
    }

    for (const failure of ["missing-format", "unverifiable", "no-dialog", "auto-generate"] as const) {
      await t.test(`確認できない動画は生成しない・失敗を保存する: ${failure}`, async () => {
        const page = await context.newPage();
        const { paperDir, state } = makeTempState();
        try {
          await mountStudioFixture(page, {
            videoDialog: failure === "no-dialog" ? "none" : failure === "auto-generate" ? "auto-generate" : "heading",
            videoSelectable: false,
          });
          if (failure === "missing-format") await page.locator("#format-explainer").evaluate(el => el.remove());
          if (failure === "unverifiable") await page.locator("#format-explainer").evaluate(el => {
            el.removeAttribute("aria-pressed");
            el.setAttribute("onclick", "document.body.dataset.clicked='true'");
          });
          assert.equal(await tryKickoffStudio(page, state, "nlm-video", [/動画解説/], 100,
            { explainerVideo: true, kickoffConfirmMs: 1 }), "skipped");
          const saved = loadState(paperDir, state);
          assert.equal(saved.kickoffFailures?.["nlm-video"], 1);
          assert.equal(hasStudioStarted(saved, "nlm-video"), false);
          assert.equal(await page.locator("#customize-dialog").isVisible(), false);
          assert.equal(await page.getAttribute("body", "data-later"), null);
          assert.deepEqual(await page.evaluate(() => (window as unknown as { __kickedOff: string[] }).__kickedOff),
            failure === "auto-generate" ? ["video"] : []);
          if (failure === "auto-generate") assert.match(saved.lastError ?? "", /カスタマイズ未確認のまま生成開始を検出/);
        } finally { await page.close(); rmSync(paperDir, { recursive: true, force: true }); }
      });
    }

    await t.test("混在カードから解説だけのメニューを開く", async () => {
      const page = await context.newPage();
      try {
        await page.setContent(`<artifact-library-item>videocam 5:00 · 短め · 1 件のソース <button onclick="document.body.dataset.chosen='short'">more_vert</button></artifact-library-item>
          <artifact-library-item>videocam 1:11 · 解説 · 1 件のソース <button onclick="document.body.dataset.chosen='explainer'">more_vert</button></artifact-library-item>`);
        assert.equal(await clickExplainerCardOverflow(page), true);
        assert.equal(await page.getAttribute("body", "data-chosen"), "explainer");
        await page.locator("artifact-library-item").last().evaluate(el => el.remove());
        assert.equal(await clickExplainerCardOverflow(page), false);
      } finally { await page.close(); }
    });

    await t.test(
      "クイズ取得後に Studio 一覧へ戻り、続けて単語帳を取得して生成中のスライドを開始失敗にしない",
      async () => {
        const page = await context.newPage();
        const startedAt = new Date(Date.now() - 120_000).toISOString();
        const { paperDir, state } = makeTempState({
          studioStarted: ["nlm-slides", "nlm-video", "nlm-quiz", "nlm-flashcards"],
          waitingFor: "nlm-quiz",
          generationStartedAt: startedAt,
        });
        try {
          await mountStudioFixture(page, {
            hasQuizReady: true,
            hasFlashcardsReady: true,
            slidesState: "generating",
            videoState: "generating",
            closeVia: "breadcrumb",
          });

          await assert.rejects(
            () =>
              runStudioParallel(page, paperDir, state, [], false, {
                outputReadyTimeoutMs: 500,
                kickoffConfirmMs: 300,
              }),
            (err: unknown) => {
              assert.ok(err instanceof GenerationWaitingError, `Expected GenerationWaitingError, got ${err}`);
              assert.equal(err.stage, "nlm-slides");
              return true;
            },
          );

          assert.equal(await studioArtifactViewerOpen(page), false);
          assert.equal(isCompleted(state, "nlm-quiz"), true);
          assert.equal(isCompleted(state, "nlm-flashcards"), true);
          assert.equal(existsSync(join(paperDir, "quiz.csv")), true);
          assert.equal(existsSync(join(paperDir, "vocab.csv")), true);
          assert.equal(hasStudioStarted(state, "nlm-slides"), true);
          assert.equal(hasStudioStarted(state, "nlm-video"), true);
          assert.equal(state.generationStartedAt, startedAt);
          const kickedOff = await page.evaluate(() => (window as unknown as { __kickedOff: string[] }).__kickedOff);
          assert.deepEqual(kickedOff, []);
        } finally {
          await page.close();
          rmSync(paperDir, { recursive: true, force: true });
        }
      },
    );

    await t.test(
      "クイズ・単語帳取得後に Studio 一覧へ戻り、未開始のスライド・動画をキックオフして GenerationWaitingError で待機する",
      async () => {
        const page = await context.newPage();
        const { paperDir, state } = makeTempState({
          studioStarted: ["nlm-quiz", "nlm-flashcards"],
        });
        try {
          await mountStudioFixture(page, {
            hasQuizReady: true,
            hasFlashcardsReady: true,
            slidesState: "none",
            videoState: "none",
            closeVia: "breadcrumb",
          });

          await assert.rejects(
            () =>
              runStudioParallel(
                page,
                paperDir,
                state,
                ["nlm-slides"],
                false,
                { outputReadyTimeoutMs: 500, kickoffConfirmMs: 300 },
              ),
            (err: unknown) => {
              assert.ok(err instanceof GenerationWaitingError, `Expected GenerationWaitingError, got ${err}`);
              assert.equal(err.stage, "nlm-video");
              return true;
            },
          );

          assert.equal(await studioArtifactViewerOpen(page), false);
          assert.equal(isCompleted(state, "nlm-quiz"), true);
          assert.equal(isCompleted(state, "nlm-flashcards"), true);
          assert.equal(hasStudioStarted(state, "nlm-video"), true);
          const kickedOff = await page.evaluate(() => (window as unknown as { __kickedOff: string[] }).__kickedOff);
          assert.deepEqual(kickedOff, ["video"]);
        } finally {
          await page.close();
          rmSync(paperDir, { recursive: true, force: true });
        }
      },
    );

    await t.test(
      "クイズ取得中にスライド完了通知が出ている場合、ビューアを閉じて既存スライドを回収し重複生成しない",
      async () => {
        const page = await context.newPage();
        const { paperDir, state } = makeTempState({
          studioStarted: ["nlm-slides", "nlm-quiz"],
        });
        try {
          await mountStudioFixture(page, {
            hasQuizReady: true,
            hasFlashcardsReady: false,
            slidesState: "ready",
            slideReadyToast: true,
            videoState: "none",
            closeVia: "close-button",
          });

          // Open quiz viewer first to simulate starting from inside the quiz viewer
          await page.evaluate(() => (window as unknown as { openViewer: (k: string) => void }).openViewer("quiz"));
          assert.equal(await studioArtifactViewerOpen(page), true);

          await collectReadyStudio(page, paperDir, state, { skipVideoDownload: true });

          assert.equal(await studioArtifactViewerOpen(page), false);
          assert.equal(isCompleted(state, "nlm-quiz"), true);
          assert.equal(isCompleted(state, "nlm-slides"), true);
          assert.equal(existsSync(join(paperDir, "quiz.csv")), true);
          assert.equal(existsSync(join(paperDir, "slides.pdf")), true);
          const quizCsvBefore = readFileSync(join(paperDir, "quiz.csv"), "utf8");

          // Running collectReadyStudio again must not re-open or overwrite existing artifacts
          await collectReadyStudio(page, paperDir, state, { skipVideoDownload: true });
          assert.equal(readFileSync(join(paperDir, "quiz.csv"), "utf8"), quizCsvBefore);
          const openCount = await page.evaluate(
            () => (window as unknown as { __openCount: { quiz: number; slides: number } }).__openCount,
          );
          assert.equal(openCount.slides, 1);
        } finally {
          await page.close();
          rmSync(paperDir, { recursive: true, force: true });
        }
      },
    );

    await t.test(
      "通常の生成待ち（GenerationWaitingError）と実エラー（ソース 0 件で開始不可）を区別する",
      async () => {
        const page = await context.newPage();
        const { paperDir, state } = makeTempState();
        try {
          await page.setContent(`
            <!doctype html>
            <html>
              <body>
                <div>0 件のソース</div>
                <div>保存したソースがここに表示されます</div>
                <h2>Studio</h2>
                <button>スライド資料 chevron_forward</button>
              </body>
            </html>
          `);

          await assert.rejects(
            () =>
              runStudioParallel(page, paperDir, state, ["nlm-video", "nlm-quiz", "nlm-flashcards"], false, {
                outputReadyTimeoutMs: 200,
                kickoffConfirmMs: 100,
              }),
            (err: unknown) => {
              assert.equal(err instanceof GenerationWaitingError, false);
              assert.ok(err instanceof Error);
              assert.match(err.message, /ソースが 0 件のため/);
              return true;
            },
          );
        } finally {
          await page.close();
          rmSync(paperDir, { recursive: true, force: true });
        }
      },
    );

    await t.test("生成の明示的な失敗を通常の生成待ちに変換しない", async () => {
      const page = await context.newPage();
      const { paperDir, state } = makeTempState();
      try {
        await mountStudioFixture(page, {});
        await page.evaluate(() => {
          (window as unknown as { confirmGenerate: () => void }).confirmGenerate = () => {
            document.getElementById("customize-dialog")!.style.display = "none";
            document.getElementById("artifact-list")!.textContent = "生成に失敗しました 再試行 削除";
          };
        });
        await assert.rejects(
          () => runStudioParallel(page, paperDir, state, ["nlm-slides", "nlm-quiz", "nlm-flashcards"], false,
            { outputReadyTimeoutMs: 100, kickoffConfirmMs: 100 }),
          /Studio 生成が失敗したままです/,
        );
        assert.equal(hasStudioStarted(state, "nlm-video"), false);
      } finally {
        await page.close();
        rmSync(paperDir, { recursive: true, force: true });
      }
    });

    await t.test("returnToStudioList: ビューアを閉じて Studio 一覧へ戻る", async () => {
      const page = await context.newPage();
      try {
        await mountStudioFixture(page, {
          hasQuizReady: true,
          slidesState: "generating",
          closeVia: "breadcrumb",
        });
        await page.evaluate(() => (window as unknown as { openViewer: (k: string) => void }).openViewer("quiz"));
        assert.equal(await studioArtifactViewerOpen(page), true);

        await returnToStudioList(page);
        assert.equal(await studioArtifactViewerOpen(page), false);
      } finally {
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }
});
