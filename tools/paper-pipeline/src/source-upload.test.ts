import test from "node:test";
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
      await t.test(`late candidate ${name}: delayed UI spends no chooser budget`, async () => {
        const page = await context.newPage();
        try {
          await page.setContent(`<button onclick="throw new Error('background selected')">パソコンから</button>
            <div role="dialog" id="modal">ソースを追加<p>デバイスからコンピュータのファイルを選択できます</p></div>`);
          // No input exists until clicking. The correct fifth-or-later label appears after the chooser budget.
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
          assert.equal(await setSourcePdf(page, pdf, { searchTimeoutMs: 1_500, clickTimeoutMs: 150, chooserTimeoutMs: 150 }), "chooser");
          assert.equal(await page.locator("#selected").evaluate((el: HTMLInputElement) => el.files?.[0]?.name), "input.pdf");
          assert.equal(chooserListeners(page), listeners);
        } finally { await page.close(); }
      });
    }

    await t.test("missing targets obey a single search deadline; no event watcher remains", async () => {
      const page = await context.newPage();
      try {
        await page.setContent('<div role="dialog">ソースを追加</div>');
        const start = Date.now();
        const listeners = chooserListeners(page);
        await assert.rejects(() => setSourcePdf(page, pdf, { searchTimeoutMs: 200 }), /探索期限/);
        assert.ok(Date.now() - start < 1_000);
        assert.equal(chooserListeners(page), listeners);
      } finally { await page.close(); }
    });

    await t.test("click failure and missing chooser have separate bounded errors and clean listeners", async () => {
      const page = await context.newPage();
      try {
        await page.setContent('<div role="dialog"><button>Upload file</button></div>');
        const listeners = chooserListeners(page);
        const start = Date.now();
        await assert.rejects(() => setSourcePdf(page, pdf, { searchTimeoutMs: 500, clickTimeoutMs: 100, chooserTimeoutMs: 100 }), /filechooser が発生しません/);
        assert.ok(Date.now() - start < 1_000);
        assert.equal(chooserListeners(page), listeners);
        await page.setContent(`<div role="dialog"><button>Upload file</button></div>
          <div style="position:fixed;inset:0;background:white;z-index:10">blocked</div>`);
        await assert.rejects(() => setSourcePdf(page, pdf, { searchTimeoutMs: 500, clickTimeoutMs: 100, chooserTimeoutMs: 100 }), /クリックできません/);
        assert.equal(chooserListeners(page), listeners);
        await page.waitForTimeout(250); // let the former event deadline pass: no unhandled rejection
      } finally { await page.close(); }
    });

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
