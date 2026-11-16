import test from "node:test";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { setSourcePdf } from "./source-upload.ts";
import { emptyState, loadState, saveState } from "./state.ts";
import { runNotebookLm } from "./steps/notebooklm.ts";

function chooserListeners(page: Page): number {
  return (page as unknown as { listenerCount(event: string): number }).listenerCount("filechooser");
}

test("NotebookLM source upload deadlines and resume (offline)", async t => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.route(/^https?:\/\//, route => route.abort());
  const dir = mkdtempSync(join(tmpdir(), "source-upload-"));
  const pdf = join(dir, "input.pdf");
  writeFileSync(pdf, "%PDF-1.4 original fixture");
  try {
    await t.test("visible modal input takes precedence over background and hidden modal inputs", async () => {
      const page = await context.newPage();
      try {
        await page.setContent(`<input type="file" id="background">
          <div role="dialog" hidden><input type="file" id="old"></div>
          <div role="dialog">ソースを追加<input type="file" hidden id="active"></div>`);
        assert.equal(await setSourcePdf(page, pdf), "input");
        assert.equal(await page.locator("#active").evaluate((el: HTMLInputElement) => el.files?.[0]?.name), "input.pdf");
        assert.equal(await page.locator("#background").evaluate((el: HTMLInputElement) => el.files?.length), 0);
        assert.equal(await page.locator("#old").evaluate((el: HTMLInputElement) => el.files?.length), 0);
      } finally { await page.close(); }
    });

    for (const name of ["ファイルをアップロード", "Choose file", "PDF"]) {
      await t.test(`late candidate ${name}: selects delayed upload UI`, async () => {
        const page = await context.newPage();
        try {
          await page.setContent(`<button onclick="throw new Error('background selected')">パソコンから</button>
            <div role="dialog" id="modal">ソースを追加<div tabindex="-1"><p>デバイスからコンピュータのファイルを選択できます</p></div></div>`);
          // Browser coverage checks late label selection; virtual-clock tests below check independent budgets.
          await page.evaluate(label => {
            setTimeout(() => {
              const button = document.createElement("button");
              button.textContent = label;
              button.onclick = () => {
                const input = document.createElement("input");
                input.type = "file";
                input.id = "selected";
                document.getElementById("modal")!.append(input);
                input.click();
              };
              document.getElementById("modal")!.append(button);
            }, 300);
          }, name);
          const listeners = chooserListeners(page);
          assert.equal(await setSourcePdf(page, pdf, { searchTimeoutMs: 15_000, clickTimeoutMs: 5_000, chooserTimeoutMs: 5_000 }), "chooser");
          assert.equal(await page.locator("#selected").evaluate((el: HTMLInputElement) => el.files?.[0]?.name), "input.pdf");
          assert.equal(chooserListeners(page), listeners);
        } finally { await page.close(); }
      });
    }

    await t.test("production NotebookLM step resumes the saved notebook, persists upload and never uploads it twice", async () => {
      const page = await context.newPage();
      const notebookUrl = "https://notebooklm.google.com/notebook/11111111-1111-4111-8111-111111111111";
      let navigations = 0;
      try {
        await page.route(notebookUrl, route => {
          navigations++;
          return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<button>ソースを追加</button>
            <div id="sources">0 件のソース</div><h2>Studio</h2><button>スライド資料 chevron_forward</button>
            <div role="dialog" id="upload">ソースを追加 ファイルをアップロード
            <input type="file" id="pdf" onchange="document.getElementById('sources').textContent='1 件のソース input.pdf';document.getElementById('upload').remove()"></div>` });
        });
        const state = emptyState({ filename: "input.pdf", inboxPdfPath: pdf, paperDir: dir });
        state.notebooklmUrl = notebookUrl;
        state.completed = ["nlm-create", "nlm-slides", "nlm-video", "nlm-quiz", "nlm-flashcards"];
        saveState(state);
        const run = () => runNotebookLm(page, { homeUrl: "https://notebooklm.google.com/", pdfPath: pdf, paperDir: dir, state, studioSkip: ["nlm-slides", "nlm-video", "nlm-quiz", "nlm-flashcards"] });
        await run();
        assert.equal(state.notebooklmUrl, notebookUrl);
        assert.ok(loadState(dir, state).completed.includes("nlm-upload"));
        assert.equal(navigations, 1);
        await run();
        assert.equal(navigations, 1);
        // Recover a missing upload checkpoint when the saved notebook already has the PDF.
        state.completed = state.completed.filter(stage => stage !== "nlm-upload");
        await run();
        assert.ok(loadState(dir, state).completed.includes("nlm-upload"));
        assert.equal(navigations, 1);
        assert.equal(readFileSync(pdf, "utf8"), "%PDF-1.4 original fixture");
      } finally { await page.close(); }
    });
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Only this fixture uses virtual time. Playwright and its transport retain real timers
// in the browser integration test above. No service or persistent profile is used.
function deadlineFixture(options: {
  visibleAt?: number;
  clickDelay?: number;
  chooserDelay?: number;
  clickFails?: boolean;
} = {}) {
  const events = new EventEmitter();
  const clickTimeouts: number[] = [];
  const files: { path: string; timeout: number }[] = [];
  const empty = { count: async () => 0 };
  const target = {
    count: async () => Date.now() >= (options.visibleAt ?? 0) ? 1 : 0,
    nth: () => target,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async ({ timeout }: { timeout: number }) => {
      clickTimeouts.push(timeout);
      if (options.chooserDelay !== undefined) {
        setTimeout(() => events.emit("filechooser", {
          setFiles: async (path: string, { timeout }: { timeout: number }) => {
            files.push({ path, timeout });
          },
        }), options.chooserDelay);
      }
      await new Promise<void>((resolve, reject) => setTimeout(
        () => options.clickFails ? reject(new Error("blocked")) : resolve(),
        options.clickFails ? timeout : (options.clickDelay ?? 0),
      ));
    },
  };
  const root = {
    isVisible: async () => true,
    locator: () => ({ ...empty, filter: () => empty }),
    getByRole: (role: string, { name }: { name: RegExp }) =>
      role === "button" && name.test("Upload file") ? target : empty,
  };
  const page = Object.assign(events, {
    locator: () => ({ count: async () => 1, nth: () => root }),
    waitForTimeout: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  }) as unknown as Page;
  return { page, clickTimeouts, files };
}

test("source upload deadlines use virtual time independent of browser scheduling", async t => {
  await t.test("UI search spends no click or chooser budget; chooser includes the click budget", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const fixture = deadlineFixture({ visibleAt: 300, clickDelay: 80, chooserDelay: 180 });
    const upload = setSourcePdf(fixture.page, "fixture.pdf", {
      searchTimeoutMs: 1_000, clickTimeoutMs: 100, chooserTimeoutMs: 100,
    });
    await nextTurn();
    for (let i = 0; i < 3; i++) {
      assert.equal(chooserListeners(fixture.page), 0);
      t.mock.timers.tick(100);
      await nextTurn();
    }
    assert.deepEqual(fixture.clickTimeouts, [100]);
    assert.equal(chooserListeners(fixture.page), 1);
    t.mock.timers.tick(80);
    await nextTurn();
    t.mock.timers.tick(100);
    assert.equal(await upload, "chooser");
    assert.deepEqual(fixture.files, [{ path: "fixture.pdf", timeout: 100 }]);
    assert.equal(chooserListeners(fixture.page), 0);
    t.mock.timers.tick(1_000); // cancelled event deadline must have no later effect
    await nextTurn();
    assert.equal(chooserListeners(fixture.page), 0);
  });

  await t.test("missing targets exhaust one search deadline without a chooser listener", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const fixture = deadlineFixture({ visibleAt: Infinity });
    const rejected = assert.rejects(setSourcePdf(fixture.page, "fixture.pdf", {
      searchTimeoutMs: 200,
    }), /探索期限/);
    await nextTurn();
    t.mock.timers.tick(100);
    await nextTurn();
    t.mock.timers.tick(100);
    await rejected;
    assert.equal(Date.now(), 200);
    assert.deepEqual(fixture.clickTimeouts, []);
    assert.equal(chooserListeners(fixture.page), 0);
  });

  for (const clickFails of [false, true]) {
    await t.test(clickFails ? "click deadline fails and cleans its watcher" : "missing chooser exhausts its own deadline", async t => {
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
      const fixture = deadlineFixture({ clickFails });
      let settled = false;
      const rejected = assert.rejects(setSourcePdf(fixture.page, "fixture.pdf", {
        searchTimeoutMs: 1_000, clickTimeoutMs: 100, chooserTimeoutMs: 200,
      }), clickFails ? /クリックできません/ : /filechooser が発生しません/).then(() => { settled = true; });
      await nextTurn();
      assert.equal(chooserListeners(fixture.page), 1);
      t.mock.timers.tick(clickFails ? 99 : 0);
      await nextTurn();
      assert.equal(settled, false);
      t.mock.timers.tick(clickFails ? 1 : 299);
      await nextTurn();
      if (!clickFails) {
        assert.equal(settled, false);
        assert.equal(chooserListeners(fixture.page), 1);
        t.mock.timers.tick(1);
      }
      await rejected;
      assert.deepEqual(fixture.clickTimeouts, [100]);
      assert.deepEqual(fixture.files, []);
      assert.equal(chooserListeners(fixture.page), 0);
      t.mock.timers.tick(1_000);
      await nextTurn();
      assert.equal(chooserListeners(fixture.page), 0);
    });
  }
});
