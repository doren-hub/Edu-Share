import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { notebookLmCsvStatusLine } from "../edushare-form.ts";
import { emptyState, markEduUploaded } from "../state.ts";
import { ensureIndustry, ensurePaperAuthor, importNotebookLmCsv, notebookLmCsvCardText, usableEduShareTitle, verifyEduSharePaper } from "./edushare.ts";

// 見出し → 説明 p → 状態 p → input。両欄の親には rounded クラスがある想定。
function titleNode(status: string): Element {
  return { nextElementSibling: { tagName: "P", textContent: "説明", nextElementSibling: {
    tagName: "P", textContent: status, nextElementSibling: { tagName: "INPUT" },
  } } } as unknown as Element;
}

function fakePage(quiz: string, vocab: string, blankReads = 0, takeOpens = false) {
  let tabOpened = false;
  let reads = 0;
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
        reads += 1;
        if (reads <= blankReads) return "";
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
    waitForURL: async () => {
      if (!takeOpens) throw new Error("開始リンクなしでは take へ遷移しない");
    },
    isClosed: () => false,
    screenshot: async () => Buffer.from([]),
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

test("issue #131: usableEduShareTitle: PDF名・ページ範囲・掲載誌/会議名・編集者欄・途中切れ・応答文の実例で filesPaste の完全題名を優先する", () => {
  // 1. PDF名（Second-law-of-information-dynamics → 075310_1_5.0100358.pdf）
  const statePdf = emptyState({ filename: "Second-law-of-information-dynamics.pdf", inboxPdfPath: "", paperDir: "" });
  statePdf.title = "075310_1_5.0100358.pdf";
  statePdf.filesPaste = [
    "Second-law-of-information-dynamics.pdf",
    "The Second Law of Information Dynamics and Its Implications for Computing",
    "2023 · Melvin M. Vopson",
    "AIP Advances",
  ].join("\n");
  assert.equal(
    usableEduShareTitle(statePdf),
    "The Second Law of Information Dynamics and Its Implications for Computing",
  );

  // 2. ページ範囲（2024.findings-acl.660 → , pages 11095–11111）
  const statePageRange = emptyState({ filename: "2024.findings-acl.660.pdf", inboxPdfPath: "", paperDir: "" });
  statePageRange.title = ", pages 11095–11111";
  statePageRange.filesPaste = [
    "2024.findings-acl.660.pdf",
    "Context-Aware Multi-Turn Dialogue Generation with Large Language Models",
    "2024 · Author Name",
    "Findings of ACL",
  ].join("\n");
  assert.equal(
    usableEduShareTitle(statePageRange),
    "Context-Aware Multi-Turn Dialogue Generation with Large Language Models",
  );

  // 3a. 掲載誌・会議名（56_244）
  const stateConf1 = emptyState({ filename: "56_244.pdf", inboxPdfPath: "", paperDir: "" });
  stateConf1.title = "56_244";
  stateConf1.filesPaste = [
    "56_244.pdf",
    "Performance Evaluation of Distributed Consensus Protocols",
    "2020 · Author Name",
    "Journal of Systems Architecture",
  ].join("\n");
  assert.equal(
    usableEduShareTitle(stateConf1),
    "Performance Evaluation of Distributed Consensus Protocols",
  );

  // 3b. 掲載誌・会議名（sec18-zhang_0）
  const stateConf2 = emptyState({ filename: "sec18-zhang_0.pdf", inboxPdfPath: "", paperDir: "" });
  stateConf2.title = "sec18-zhang_0";
  stateConf2.filesPaste = [
    "sec18-zhang_0.pdf",
    "Towards Automated Security Analysis of Smart Contracts",
    "2018 · Alice Zhang, Bob Lee",
    "USENIX Security Symposium",
  ].join("\n");
  assert.equal(
    usableEduShareTitle(stateConf2),
    "Towards Automated Security Analysis of Smart Contracts",
  );

  // 4. 編集者欄（Academic Editors: …）
  const stateEditor = emptyState({ filename: "paper.pdf", inboxPdfPath: "", paperDir: "" });
  stateEditor.title = "Academic Editors: …";
  stateEditor.filesPaste = [
    "paper.pdf",
    "Single-Cell RNA Sequencing Analysis of Tumor Microenvironments",
    "2022 · Author Name",
    "Cancers",
  ].join("\n");
  assert.equal(
    usableEduShareTitle(stateEditor),
    "Single-Cell RNA Sequencing Analysis of Tumor Microenvironments",
  );

  // 5. 途中切れ（s41586-024-07566-y → AI models collapse when trained on）
  const stateTruncated = emptyState({ filename: "s41586-024-07566-y.pdf", inboxPdfPath: "", paperDir: "" });
  stateTruncated.title = "AI models collapse when trained on";
  stateTruncated.filesPaste = [
    "s41586-024-07566-y.pdf",
    "AI models collapse when trained on recursively generated data",
    "2024 · Ilia Shumailov, Zakhar Shumaylov, Yiren Zhao",
    "Nature",
  ].join("\n");
  assert.equal(
    usableEduShareTitle(stateTruncated),
    "AI models collapse when trained on recursively generated data",
  );

  // 6. 応答文（nttjnl5103_20231101 → Not addressed in the paper.）
  const stateResponse = emptyState({ filename: "nttjnl5103_20231101.pdf", inboxPdfPath: "", paperDir: "" });
  stateResponse.title = "Not addressed in the paper.";
  stateResponse.filesPaste = [
    "nttjnl5103_20231101.pdf",
    "Recent Advances in Quantum Key Distribution Technologies",
    "2023 · Author Name",
    "NTT Technical Review",
  ].join("\n");
  assert.equal(
    usableEduShareTitle(stateResponse),
    "Recent Advances in Quantum Key Distribution Technologies",
  );

  // 7. 不正な候補タイトルで filesPaste にも有効な題名が無い場合は空文字を返す
  const stateInvalidNoPaste = emptyState({ filename: "bad.pdf", inboxPdfPath: "", paperDir: "" });
  stateInvalidNoPaste.title = ", pages 11095–11111";
  stateInvalidNoPaste.filesPaste = "";
  assert.equal(usableEduShareTitle(stateInvalidNoPaste), "");

  // 8. 正常な完全タイトルは維持される（p53 や Editor 等を含むタイトルも誤除外されない）
  const stateValid = emptyState({ filename: "resnet.pdf", inboxPdfPath: "", paperDir: "" });
  stateValid.title = "Deep Residual Learning for Image Recognition";
  stateValid.filesPaste = "";
  assert.equal(usableEduShareTitle(stateValid), "Deep Residual Learning for Image Recognition");

  stateValid.title = "p53 mutations in human cancers";
  assert.equal(usableEduShareTitle(stateValid), "p53 mutations in human cancers");

  stateValid.title = "Editor bias in peer review";
  assert.equal(usableEduShareTitle(stateValid), "Editor bias in peer review");
});

test("ensureIndustry: 自動判定成功時は選択して state.industry に保存する", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensure-industry-"));
  try {
    const state = emptyState({ filename: "nanosheet.pdf", inboxPdfPath: "", paperDir: root });
    let selected = "";
    const fakeSelect = {
      isVisible: async () => true,
      waitFor: async () => {},
      inputValue: async () => selected,
      locator: () => ({
        allTextContents: async () => ["選択してください", "半導体・電子デバイス", "AI・データ", "その他"],
      }),
      selectOption: async (opt: any) => {
        selected = typeof opt === "string" ? opt : (opt.label || opt.value || "");
      },
    };
    const page = {
      locator: (sel: string) => {
        if (sel === "#paper-industry") return fakeSelect;
        throw new Error(`Unexpected selector: ${sel}`);
      },
    } as unknown as Page;

    await ensureIndustry(page, "Review of Nanosheet Transistors Technology", state);
    assert.equal(selected, "半導体・電子デバイス");
    assert.equal(state.industry, "半導体・電子デバイス");

    const saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.equal(saved.industry, "半導体・電子デバイス");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("状態行の初回読みが空でも取り込み済みなら確認を通す", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-verify-late-"));
  try {
    const state = emptyState({ filename: "paper.pdf", inboxPdfPath: join(root, "paper.pdf"), paperDir: root });
    state.eduShareTestUrl = "https://example.test/tests/test";
    state.quizCsvPath = join(root, "quiz.csv");
    state.vocabCsvPath = join(root, "vocab.csv");
    writeFileSync(state.quizCsvPath, "csv");
    writeFileSync(state.vocabCsvPath, "csv");
    const { page } = fakePage("取り込み済み（12問）", "取り込み済み（40問）", 2);
    await verifyEduSharePaper(page, { paperDir: root, state, skipSlidesVideo: true });
    assert.ok(state.completed.includes("verify"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureIndustry: 業界が空になったときは state.industry に「業界未判定」と残す", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensure-industry-unset-"));
  try {
    const state = emptyState({ filename: "unknown.pdf", inboxPdfPath: "", paperDir: root });
    let selected = "";
    const fakeSelect = {
      isVisible: async () => true,
      waitFor: async () => {},
      inputValue: async () => selected,
      locator: () => ({
        allTextContents: async () => ["選択してください", "半導体・電子デバイス", "AI・データ", "その他"],
      }),
      selectOption: async (opt: any) => {
        selected = typeof opt === "string" ? opt : (opt.label || opt.value || "");
      },
    };
    const page = {
      locator: (sel: string) => {
        if (sel === "#paper-industry") return fakeSelect;
        throw new Error(`Unexpected selector: ${sel}`);
      },
    } as unknown as Page;

    await ensureIndustry(page, "Unrelated and uncategorized generic document", state);
    assert.equal(selected, "");
    assert.equal(state.industry, "業界未判定");

    const saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.equal(saved.industry, "業界未判定");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("開始ボタンが無くてもクイズと単語帳のCSVプールURLが開けば確認を通す", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-verify-take-"));
  try {
    const state = emptyState({ filename: "paper.pdf", inboxPdfPath: join(root, "paper.pdf"), paperDir: root });
    state.eduShareTestUrl = "https://example.test/tests/test";
    state.quizCsvPath = join(root, "quiz.csv");
    state.vocabCsvPath = join(root, "vocab.csv");
    writeFileSync(state.quizCsvPath, "csv");
    writeFileSync(state.vocabCsvPath, "csv");
    const { page, navigations } = fakePage("", "", 0, true);
    await verifyEduSharePaper(page, { paperDir: root, state, skipSlidesVideo: true });
    assert.ok(state.completed.includes("verify"));
    assert.ok(navigations.some((url) => url.includes("csvPool=quiz")));
    assert.ok(navigations.some((url) => url.includes("csvPool=vocab")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CSVプールURLを開けず手元にクイズCSVがあるときはエラーとなり取り込み済みマークを解除する", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-verify-quiz-fail-"));
  try {
    const state = emptyState({ filename: "paper.pdf", inboxPdfPath: join(root, "paper.pdf"), paperDir: root });
    state.eduShareTestUrl = "https://example.test/tests/test";
    state.quizCsvPath = join(root, "quiz.csv");
    state.vocabCsvPath = join(root, "vocab.csv");
    writeFileSync(state.quizCsvPath, "csv");
    writeFileSync(state.vocabCsvPath, "csv");
    markEduUploaded(state, "nlm-quiz");
    markEduUploaded(state, "nlm-flashcards");
    assert.ok(state.eduUploaded?.includes("nlm-quiz"));

    const { page } = fakePage("", "", 0, false);
    await assert.rejects(
      async () => {
        await verifyEduSharePaper(page, { paperDir: root, state, skipSlidesVideo: true });
      },
      { message: "Edu Share にクイズ CSV がありません" },
    );
    assert.ok(!state.eduUploaded?.includes("nlm-quiz"));
    const saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.ok(!saved.eduUploaded?.includes("nlm-quiz"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CSVプールURLを開けず手元に単語帳CSVがあるときはエラーとなり取り込み済みマークを解除する", async () => {
  const root = mkdtempSync(join(tmpdir(), "csv-verify-vocab-fail-"));
  try {
    const state = emptyState({ filename: "paper.pdf", inboxPdfPath: join(root, "paper.pdf"), paperDir: root });
    state.eduShareTestUrl = "https://example.test/tests/test";
    state.quizCsvPath = join(root, "quiz.csv");
    state.vocabCsvPath = join(root, "vocab.csv");
    writeFileSync(state.quizCsvPath, "csv");
    writeFileSync(state.vocabCsvPath, "csv");
    markEduUploaded(state, "nlm-quiz");
    markEduUploaded(state, "nlm-flashcards");
    assert.ok(state.eduUploaded?.includes("nlm-flashcards"));

    const { page } = fakePage("取り込み済み（12問）", "", 0, false);
    await assert.rejects(
      async () => {
        await verifyEduSharePaper(page, { paperDir: root, state, skipSlidesVideo: true });
      },
      { message: "Edu Share に単語帳 CSV がありません" },
    );
    assert.ok(!state.eduUploaded?.includes("nlm-flashcards"));
    assert.ok(state.eduUploaded?.includes("nlm-quiz"));
    const saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.ok(!saved.eduUploaded?.includes("nlm-flashcards"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFakeAuthorPage(initialOptions: string[]) {
  let selectedOption = "";
  let otherFilled = "";
  const currentOptions = [...initialOptions];

  const fakeSelect = {
    isVisible: async () => true,
    waitFor: async () => {},
    inputValue: async () => selectedOption,
    locator: () => ({
      evaluateAll: async (fn: any) =>
        fn(currentOptions.map((v) => ({ value: v }))),
    }),
    selectOption: async (opt: any) => {
      const val = typeof opt === "string" ? opt : opt.value || "";
      selectedOption = val;
      return [val];
    },
  };

  const fakeOther = {
    waitFor: async () => {},
    fill: async (text: string) => {
      otherFilled = text;
    },
    blur: async () => {},
  };

  const page = {
    locator: (sel: string) => {
      if (sel === "#paper-author-0") return fakeSelect;
      throw new Error(`Unexpected selector: ${sel}`);
    },
    getByLabel: (regex: RegExp) => {
      if (regex.test("著者 1（その他の内容）")) return fakeOther;
      throw new Error(`Unexpected label query: ${regex}`);
    },
    waitForTimeout: async () => {},
    evaluate: async (fn: any, arg: any) => {
      if (typeof fn === "function" && arg?.selId === "paper-author-0") {
        if (!currentOptions.includes(arg.name)) {
          currentOptions.push(arg.name);
        }
      }
    },
  } as unknown as Page;

  return {
    page,
    getSelected: () => selectedOption,
    getOtherFilled: () => otherFilled,
    getOptions: () => currentOptions,
  };
}

test("Issue #333: ensurePaperAuthor: 選択肢にない妥当な著者名のとき、選択肢に追加してから素の名前を選ぶ", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensure-author-add-"));
  try {
    const state = emptyState({ filename: "resnet.pdf", inboxPdfPath: "", paperDir: root });
    state.filesPaste = "resnet.pdf\nTitle: Deep Residual Learning\nAuthors: Kaiming He, Xiangyu Zhang\n";
    state.title = "Deep Residual Learning";

    const { page, getSelected } = createFakeAuthorPage(["", "Alice Smith", "その他"]);
    let picklistAddedName = "";
    const fakeDeps = {
      extractPdfText: async () => undefined,
      fetchCrossrefWork: async () => null,
      ensureExpertNamePicklist: async (_page: Page, name: string) => {
        picklistAddedName = name;
        return true;
      },
    };

    await ensurePaperAuthor(page, state, fakeDeps);

    assert.equal(picklistAddedName, "Kaiming He");
    assert.equal(getSelected(), "Kaiming He");
    assert.equal(state.author, "Kaiming He");

    const saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.equal(saved.author, "Kaiming He");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Issue #333: ensurePaperAuthor: 選択肢への追加が失敗したとき、「その他」の自由入力に倒れる", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensure-author-fail-"));
  try {
    const state = emptyState({ filename: "resnet.pdf", inboxPdfPath: "", paperDir: root });
    state.filesPaste = "resnet.pdf\nTitle: Deep Residual Learning\nAuthors: Kaiming He, Xiangyu Zhang\n";
    state.title = "Deep Residual Learning";

    const { page, getSelected, getOtherFilled } = createFakeAuthorPage(["", "Alice Smith", "その他"]);
    const fakeDeps = {
      extractPdfText: async () => undefined,
      fetchCrossrefWork: async () => null,
      ensureExpertNamePicklist: async () => false, // 失敗
    };

    await ensurePaperAuthor(page, state, fakeDeps);

    assert.equal(getSelected(), "その他");
    assert.equal(getOtherFilled(), "Kaiming He");
    assert.equal(state.author, "Kaiming He");

    const saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
    assert.equal(saved.author, "Kaiming He");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Issue #333: ensurePaperAuthor: 著者未設定とおかしい値は、選択肢に追加されない", async () => {
  for (const badAuthor of ["著者未設定", "DOI", "III", "不明", "Graphs"]) {
    const root = mkdtempSync(join(tmpdir(), "ensure-author-bad-"));
    try {
      const state = emptyState({ filename: "paper.pdf", inboxPdfPath: "", paperDir: root });
      state.filesPaste = badAuthor === "著者未設定" ? "" : `paper.pdf\nAuthors: ${badAuthor}\n`;
      state.title = "Title";

      const { page, getSelected, getOtherFilled } = createFakeAuthorPage(["", "Alice Smith", "その他"]);
      let picklistAttempted = false;
      const fakeDeps = {
        extractPdfText: async () => undefined,
        fetchCrossrefWork: async () => null,
        ensureExpertNamePicklist: async () => {
          picklistAttempted = true;
          return true;
        },
      };

      await ensurePaperAuthor(page, state, fakeDeps);

      assert.equal(picklistAttempted, false, `${badAuthor} は picklist に追加されてはならない`);
      assert.equal(getSelected(), "その他");
      assert.equal(getOtherFilled(), "著者未設定");
      assert.equal(state.author, "著者未設定");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Issue #333: ensurePaperAuthor: Files に著者がなく PDF 1 ページ目から補完して選択肢に追加・選択する", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensure-author-pdf-"));
  try {
    const pdfPath = join(root, "paper.pdf");
    writeFileSync(pdfPath, "dummy-pdf");
    const state = emptyState({ filename: "paper.pdf", inboxPdfPath: pdfPath, paperDir: root });
    state.filesPaste = "paper.pdf\nタイトルのみで著者行なし";
    state.title = "自然言語処理の研究";

    const pdfText = `
自然言語処理の研究
山田 太郎†
†東京大学
要旨
概要本文...
`;
    const { page, getSelected } = createFakeAuthorPage(["", "その他"]);
    let addedName = "";
    const fakeDeps = {
      extractPdfText: async () => pdfText,
      fetchCrossrefWork: async () => null,
      ensureExpertNamePicklist: async (_page: Page, name: string) => {
        addedName = name;
        return true;
      },
    };

    await ensurePaperAuthor(page, state, fakeDeps);

    assert.equal(addedName, "山田 太郎");
    assert.equal(getSelected(), "山田 太郎");
    assert.equal(state.author, "山田 太郎");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Issue #333: ensurePaperAuthor: Files にも PDF にも著者がなく DOI 照会から補完する", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensure-author-doi-"));
  try {
    const state = emptyState({ filename: "paper.pdf", inboxPdfPath: join(root, "paper.pdf"), paperDir: root });
    state.filesPaste = "paper.pdf\n著者なし";
    state.title = "Attention Is All You Need";
    state.doi = "10.1234/test.doi";

    const { page, getSelected } = createFakeAuthorPage(["", "その他"]);
    let addedName = "";
    const fakeDeps = {
      extractPdfText: async () => "Image only document",
      fetchCrossrefWork: async (doi: string) => ({
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        year: "2017",
        venue: "NeurIPS",
        doi,
      }),
      ensureExpertNamePicklist: async (_page: Page, name: string) => {
        addedName = name;
        return true;
      },
    };

    await ensurePaperAuthor(page, state, fakeDeps);

    assert.equal(addedName, "Ashish Vaswani");
    assert.equal(getSelected(), "Ashish Vaswani");
    assert.equal(state.author, "Ashish Vaswani");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Issue #333: ensurePaperAuthor: 参考文献の引用 DOI や題名不一致の Crossref は採用せず著者未設定に倒す", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensure-author-ref-"));
  try {
    const pdfPath = join(root, "paper.pdf");
    writeFileSync(pdfPath, "dummy-pdf");
    // inboxPdfPath は存在しない古いパスだが paperDir/filename に実体があるケース
    const state = emptyState({
      filename: "paper.pdf",
      inboxPdfPath: join(root, "nonexistent-inbox.pdf"),
      paperDir: root,
    });
    state.filesPaste = "paper.pdf\n著者なし";
    state.title = "Target Paper Title";

    // 3500 文字以降の参考文献にだけ他論文の DOI がある
    const pdfText = "B".repeat(3500) + "\nReferences\n[1] https://doi.org/10.9999/other.cited.ref\n";

    const { page, getSelected, getOtherFilled } = createFakeAuthorPage(["", "その他"]);
    let picklistAdded = false;
    const fakeDeps = {
      extractPdfText: async () => pdfText,
      fetchCrossrefWork: async () => ({
        title: "Completely Different Title",
        authors: ["Cited Person"],
        year: "2015",
        venue: "Cited Venue",
        doi: "10.9999/other.cited.ref",
      }),
      ensureExpertNamePicklist: async () => {
        picklistAdded = true;
        return true;
      },
    };

    await ensurePaperAuthor(page, state, fakeDeps);

    assert.equal(picklistAdded, false);
    assert.equal(getSelected(), "その他");
    assert.equal(getOtherFilled(), "著者未設定");
    assert.equal(state.author, "著者未設定");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

