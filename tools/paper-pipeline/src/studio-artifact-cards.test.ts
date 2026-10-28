import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { hasSlideDeckInStudioText, shouldKickoffSlides } from "./studio-cards.ts";
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
    await t.test("Issue #137: unknown Studio markup distinguishes creation tiles from completed slides", async () => {
      const tiles = `<h2>Studio</h2><button>tablet スライド資料 chevron_forward</button>
        <button>subscriptions 動画解説 chevron_forward</button><button>quiz クイズ chevron_forward</button>`;
      const slide = `<section class="future-output"><span>tablet</span><h3>クイズを使った学習</h3>
        <p>1 件のソース · 2 分前</p><button>more_vert</button></section>`;
      const quiz = `<section class="future-output">quiz スライド資料の理解 <p>1 件のソース · 2 分前</p><button>more_vert</button></section>`;
      for (const [html, expected] of [
        [tiles, false], [tiles + quiz, false], [tiles + slide, true], [tiles + quiz + slide, true],
        [tiles + slide.replace("1 件のソース · 2 分前", "sync"), false],
        ["<aside>tablet ソース 1 件のソース · 2 分前</aside>" + tiles, false],
      ] as const) {
        await page.setContent(html);
        assert.equal((await studioArtifactCards(page)).length, 0);
        const body = await page.locator("body").innerText();
        assert.equal(hasSlideDeckInStudioText(body), expected, body);
        assert.equal(shouldKickoffSlides([body]), !expected, body);
        // Flattening destroys heading boundaries; fail closed rather than scanning sources.
        assert.equal(hasSlideDeckInStudioText(body.replace(/\s+/g, " ")), false, body);
      }
      await page.setContent(tiles + slide.replace("2 分前", "2 分前 sync"));
      assert.equal(hasSlideDeckInStudioText(await page.locator("body").innerText()), false);
    });
    await t.test("Issue #149: source names and reordered panels cannot leak into Studio fallback", async () => {
      const tiles = `<h2>Studio</h2><button>tablet スライド資料 chevron_forward</button>`;
      const source = `<h2>ソース</h2><aside>Studio research.pdf
        <div>tablet ソースの表示</div><p>1 件のソース · 2 分前</p></aside>`;
      const chat = `<h2>チャット</h2><p>tablet 回答 1 件のソース · 2 分前</p>`;
      const slide = `<section><div>tablet</div><h3>完成スライド</h3>
        <p>1 件のソース · 2 分前</p><button>more_vert</button></section>`;
      for (const [html, expected] of [
        [source + tiles, false], [tiles + source, false],
        [tiles + chat + source, false], [source + chat + tiles, false],
        [source + tiles + slide + chat, true], [tiles + slide + source + chat, true],
        [chat + tiles + slide + source, true],
        [source.replace("Studio research.pdf", "Studio") + tiles, false],
        [source.replace("Studio research.pdf", "Studio") + tiles + slide, false],
        [source.replace("ソース", "Sources") + tiles + slide + chat.replace("チャット", "Chat"), true],
        [tiles + source.replace("ソース", "Sources"), false],
        [source + "<h2>Studio</h2>", false],
        ["<h2>Studio</h2>" + source, false],
        ["<h2>Studio</h2>" + slide + source, true],
        [tiles.replace("Studio</h2>", "Studio <button>dock_to_left</button></h2>") + slide + source, true],
        [source.replace("Studio research.pdf", "Studio dock_to_left") + tiles + slide, false],
        [tiles + source.replace("ソース</h2>", "ソース <button>collapse_content</button></h2>"), false],
        [tiles + chat.replace("チャット</h2>", "Chat <button>dock_to_right</button></h2>"), false],
      ] as const) {
        await page.setContent(html);
        assert.equal((await studioArtifactCards(page)).length, 0);
        const body = await page.locator("body").innerText();
        assert.equal(hasSlideDeckInStudioText(body), expected, body);
        assert.equal(shouldKickoffSlides([body]), !expected, body);
        assert.equal(hasSlideDeckInStudioText(body.replace(/\s+/g, " ")), false, body);
      }
    });
    await t.test("Issue #135: the leading icon wins over later control icons", async () => {
      for (const [leading, later, expected] of [
        ["audio_spark", "tablet", "other"], ["future_icon", "quiz", "other"],
        ["quiz", "tablet", "quiz"], ["tablet", "copy", "slides"],
        ["subscriptions", "quiz", "video"],
      ] as const) {
        for (const tag of ["mat-icon", "span class='google-symbols'", "span class='material-symbols-outlined'"]) {
          const close = tag.split(" ")[0];
          await page.setContent(`<artifact-library-item style="display:block">
            <${tag}>${leading}</${close}><span>任意の題名</span>
            <span>1 件のソース · 2 分前</span><button class="artifact-stretched-button">開く</button>
            <button><span class="artifact-icon">${later}</span></button>
          </artifact-library-item>`);
          const cards = await studioArtifactCards(page);
          assert.equal(cards.length, 1);
          assert.equal(cards[0]!.kind, expected, `${leading} before ${later}`);
        }
      }
    });
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
