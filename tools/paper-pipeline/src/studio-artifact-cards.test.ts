import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  hasBusyStudioArtifact,
  hasInProgressStudioArtifact,
  hasReadyStudioArtifact,
  hasStudioArtifact,
  openStudioArtifact,
  studioArtifactCards,
} from "./studio-artifact-cards.ts";

test("Studio artifact fixture: kinds, ready state and covered title buttons", async t => {
  const browser = await chromium.launch().catch(async e => {
    if (!String(e).includes("Executable doesn't exist")) throw e;
    return chromium.launch({ channel: "chrome" });
  });
  try {
    const page = await browser.newPage();
    const row = (id: string, icon: string, title: string, date = "7 日前", busy = false) => `
      <artifact-library-item style="display:block;position:relative;width:400px;height:80px">
        <div class="artifact-button-content">
          <button class="artifact-stretched-button" aria-labelledby="artifact-labels-${id}"
            onclick="document.body.dataset.opened='${id}'"
            style="position:absolute;inset:0;width:100%;height:100%;z-index:2"></button>
          <div class="artifact-primary-content" id="artifact-labels-${id}">
            <span class="artifact-icon">${icon}</span><span class="artifact-title">${title}</span>
            <span>1 件のソース · ${date}</span>${busy ? "<mat-icon>sync</mat-icon>" : ""}
          </div>
          <button class="artifact-more-button" onclick="document.body.dataset.opened='menu'">more_vert</button>
        </div>
      </artifact-library-item>`;
    await t.test("arbitrary titles and misleading other-kind titles use the icon", async () => {
      await page.setContent(`<button>quiz クイズ</button><aside>copy 記憶カード 1 件のソース · 7 日前</aside>
        ${row("slide", "tablet", "クイズと暗記カードの作り方")}
        ${row("quiz", "quiz", "Generating 練習問題")}
        ${row("flashcards", "copy", "任意題名 記憶カード")}
        ${row("unknown", "future_icon", "クイズ")}`);
      for (const kind of ["quiz", "flashcards", "slides"] as const) {
        assert.equal(await hasStudioArtifact(page, kind), true);
        assert.equal(await hasReadyStudioArtifact(page, kind), true);
        assert.equal(await openStudioArtifact(page, kind), true);
        assert.equal(await page.locator("body").getAttribute("data-opened"), kind === "slides" ? "slide" : kind);
      }
      assert.equal((await studioArtifactCards(page)).length, 4);
    });
    await t.test("generating and in-progress cards are detected by hasStudioArtifact to prevent re-generation, but cannot be opened until ready", async () => {
      await page.setContent(`
        ${row("generating-quiz", "quiz", "任意題名 練習問題", "7 日前", true)}
        ${row("undated-flashcards", "copy", "任意題名 単語カード", "")}
      `);
      assert.equal(await hasStudioArtifact(page, "quiz"), true);
      assert.equal(await hasStudioArtifact(page, "flashcards"), true);
      assert.equal(await hasStudioArtifact(page, "slides"), false);

      assert.equal(await hasReadyStudioArtifact(page, "quiz"), false);
      assert.equal(await hasReadyStudioArtifact(page, "flashcards"), false);
      assert.equal(await openStudioArtifact(page, "quiz"), false);
      assert.equal(await openStudioArtifact(page, "flashcards"), false);
      assert.equal(await hasBusyStudioArtifact(page, "quiz"), true);
      assert.equal(await hasInProgressStudioArtifact(page, "quiz"), true);
      assert.equal(await hasInProgressStudioArtifact(page, "flashcards"), true);
      assert.equal(await hasInProgressStudioArtifact(page, "slides"), false);
    });
    await t.test("creation tiles and sources outside artifact items are ignored completely", async () => {
      await page.setContent(`<button>quiz 確認テスト 1 件のソース · 7 日前</button>
        <aside><button>copy 単語カード 1 件のソース · 7 日前</button></aside>
        ${row("other", "future_icon", "クイズ")}
        ${row("missing-icon", "", "クイズ")}`);
      await page.locator("body").evaluate(el => el.removeAttribute("data-opened"));
      for (const kind of ["quiz", "flashcards", "slides"] as const) {
        assert.equal(await hasStudioArtifact(page, kind), false);
        assert.equal(await hasReadyStudioArtifact(page, kind), false);
        assert.equal(await openStudioArtifact(page, kind), false);
      }
      assert.equal(await page.locator("body").getAttribute("data-opened"), null);
    });
    await t.test("legacy artifact rows retain title-based compatibility without global date lookup", async () => {
      await page.setContent(`<div class="artifact-item-button" onclick="document.body.dataset.opened='legacy'">
        暗記カード 1 件のソース · 昨日</div><aside>クイズ 1 件のソース · 昨日</aside>
        <div class="artifact-item-button">任意題名 確認テスト 1 件のソース · 昨日</div>`);
      assert.equal(await hasStudioArtifact(page, "flashcards"), true);
      assert.equal(await hasStudioArtifact(page, "quiz"), false);
      assert.equal(await hasStudioArtifact(page, "slides"), false);
      assert.equal(await hasReadyStudioArtifact(page, "flashcards"), true);
      assert.equal(await hasReadyStudioArtifact(page, "quiz"), false);
      assert.equal(await hasReadyStudioArtifact(page, "slides"), false);
      assert.equal(await openStudioArtifact(page, "flashcards"), true);
      assert.equal(await page.locator("body").getAttribute("data-opened"), "legacy");
    });
    await t.test("Issue #129: cards with unread badges, mat-icon or innerText icons, and arbitrary titles", async () => {
      const unreadRow = (id: string, icon: string, title: string) => `
        <artifact-library-item style="display:block;position:relative;width:400px;height:80px">
          <div class="artifact-button-content">
            <button class="artifact-stretched-button" aria-labelledby="artifact-labels-${id}"
              onclick="document.body.dataset.opened='${id}'"
              style="position:absolute;inset:0;width:100%;height:100%;z-index:2"></button>
            <div class="artifact-primary-content" id="artifact-labels-${id}">
              <mat-icon>${icon}</mat-icon><span>未読</span><span class="artifact-title">${title}</span>
              <span>1 件のソース · 18 時間前</span>
            </div>
            <button class="artifact-more-button">more_vert</button>
          </div>
        </artifact-library-item>`;

      await page.setContent(`
        ${unreadRow("fc-browser", "copy", "ブラウザ アプリケーション")}
        ${unreadRow("quiz-jpn", "quiz", "2_JPN-134")}
        ${unreadRow("slide-prog", "tablet", "Syntactic and semantic interactions")}
        ${unreadRow("fc-transfer", "copy", "学習の転移 単語カード")}
      `);

      assert.equal(await hasStudioArtifact(page, "flashcards"), true);
      assert.equal(await hasStudioArtifact(page, "quiz"), true);
      assert.equal(await hasStudioArtifact(page, "slides"), true);

      assert.equal(await hasReadyStudioArtifact(page, "flashcards"), true);
      assert.equal(await hasReadyStudioArtifact(page, "quiz"), true);
      assert.equal(await hasReadyStudioArtifact(page, "slides"), true);

      assert.equal(await openStudioArtifact(page, "slides"), true);
      assert.equal(await page.locator("body").getAttribute("data-opened"), "slide-prog");

      assert.equal(await openStudioArtifact(page, "quiz"), true);
      assert.equal(await page.locator("body").getAttribute("data-opened"), "quiz-jpn");

      assert.equal(await openStudioArtifact(page, "flashcards"), true);
      assert.equal(await page.locator("body").getAttribute("data-opened"), "fc-browser");
    });
  } finally {
    await browser.close();
  }
});
