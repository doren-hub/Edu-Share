import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { notebookLmCsvStatusLine } from "../edushare-form.ts";
import { emptyState } from "../state.ts";
import { importNotebookLmCsv, notebookLmCsvCardText, verifyEduSharePaper } from "./edushare.ts";

// 見出し → 説明 p → 状態 p → input。両欄の親には rounded クラスがある想定。
function titleNode(status: string): Element {
  return { nextElementSibling: { tagName: "P", textContent: "説明", nextElementSibling: {
    tagName: "P", textContent: status, nextElementSibling: { tagName: "INPUT" },
  } } } as unknown as Element;
}

function fakePage(quiz: string, vocab: string) {
  let tabOpened = false;
  const sent: number[] = [];
  const navigations: string[] = [];
  function loc(key = "", index = 0): any {
    const chain: any = {
      first: () => chain, last: () => chain, filter: () => chain, locator: () => chain,
      nth: (i: number) => loc(key, i), getByRole: (role: string, opts: { name?: string } = {}) => loc(`${role}:${opts.name}`),
      isVisible: async () => !key.includes("csvPool="),
      count: async () => key.includes("csvPool=") ? 0 : 1,
      scrollIntoViewIfNeeded: async () => {}, waitFor: async () => {},
      innerText: async () => key === "span.rounded-full" ? "ready" : "登録済み",
      click: async () => { if (key === "tab:NotebookLM CSV") tabOpened = true; },
      setInputFiles: async () => { sent.push(index); },
      evaluate: async (fn: typeof notebookLmCsvStatusLine) => {
        if (tabOpened) throw new Error("form hidden by CSV tab");
        return fn(titleNode(key === "クイズ（選択肢）" ? quiz : vocab));
      },
    };
    return chain;
  }
  const page = {
    locator: (key: string) => loc(key),
    getByText: (key: string) => loc(key),
    getByRole: (role: string, opts: { name?: string } = {}) => loc(`${role}:${opts.name}`),
    goto: async (url: string) => { navigations.push(url); tabOpened = false; },
    waitForTimeout: async () => {},
    waitForURL: async () => { throw new Error("開始リンクなしでは take へ遷移しない"); },
  } as unknown as Page;
  return { page, sent, navigations };
}

test("単語帳だけ取り込み済みならクイズを送り、単語帳は送らない", async () => {
  const { page, sent } = fakePage("未取り込み", "取り込み済み（40問）");
  assert.equal(await notebookLmCsvCardText(page, "クイズ（選択肢）"), "未取り込み");
  assert.equal(await notebookLmCsvCardText(page, "単語帳（Flashcard）"), "取り込み済み（40問）");
  await importNotebookLmCsv(page, "/fake/quiz.csv", 0, "クイズ CSV を取り込む", "success", "クイズ（選択肢）");
  await importNotebookLmCsv(page, "/fake/vocab.csv", 1, "単語帳 CSV を取り込む", "success", "単語帳（Flashcard）");
  assert.deepEqual(sent, [0]);
});

test("両欄取り込み済みならCSVタブで欄が隠れ開始リンクが無くても確認を通す", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-verify-"));
  try {
    const state = emptyState({ filename: "paper.pdf", inboxPdfPath: join(root, "paper.pdf"), paperDir: root });
    state.eduShareTestUrl = "https://example.test/tests/test";
    state.quizCsvPath = join(root, "quiz.csv");
    state.vocabCsvPath = join(root, "vocab.csv");
    writeFileSync(state.quizCsvPath, "csv");
    writeFileSync(state.vocabCsvPath, "csv");
    const { page, navigations } = fakePage("取り込み済み（12問）", "取り込み済み（40問）");
    await verifyEduSharePaper(page, { paperDir: root, state, skipSlidesVideo: true });
    assert.ok(state.completed.includes("verify"));
    assert.deepEqual(navigations, [state.eduShareTestUrl]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
