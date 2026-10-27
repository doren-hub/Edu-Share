import test from "node:test";
import assert from "node:assert/strict";
import { applyExtractedCard } from "./scispace.ts";
import { emptyState } from "../state.ts";

test("applyExtractedCard: Not addressed in the paper. は題名・説明に採用せずファイル名にフォールバックする", () => {
  const state = emptyState({ filename: "quantum_paper.pdf", inboxPdfPath: "/tmp/quantum_paper.pdf", paperDir: "/tmp" });
  const card = {
    title: "Not addressed in the paper.",
    yearAuthorLine: "2023 · Not specified",
    authors: "Not specified",
    publicationYear: "2023",
    venue: "",
    doi: "",
    paste: "",
    tldr: "The paper does not mention any conclusions.",
  };

  applyExtractedCard(state, "quantum_paper.pdf", card);
  assert.equal(state.title, "quantum_paper");
  assert.equal(state.tldr, "");
});

test("applyExtractedCard: スキャンの PDF では題名・説明を採用しない", () => {
  const state = emptyState({ filename: "scanned_doc.pdf", inboxPdfPath: "/tmp/scanned_doc.pdf", paperDir: "/tmp" });
  const card = {
    title: "Deep Residual Learning for Image Recognition",
    yearAuthorLine: "2016 · Kaiming He",
    authors: "Kaiming He",
    publicationYear: "2016",
    venue: "CVPR",
    doi: "10.1109/CVPR.2016.90",
    paste: "",
    tldr: "This paper presents a residual learning framework to ease the training of substantially deeper neural networks.",
  };

  const scannedPdfText = "Page 1 [image only]";
  applyExtractedCard(state, "scanned_doc.pdf", card, [], scannedPdfText);

  // スキャン PDF では SciSpace の題名と説明を採用せず、題名はファイル名、説明は空
  assert.equal(state.title, "scanned_doc");
  assert.equal(state.tldr, "");
});

test("applyExtractedCard: 本文と合う題名と説明は採用する", () => {
  const state = emptyState({ filename: "resnet.pdf", inboxPdfPath: "/tmp/resnet.pdf", paperDir: "/tmp" });
  const card = {
    title: "Deep Residual Learning for Image Recognition",
    yearAuthorLine: "2016 · Kaiming He",
    authors: "Kaiming He",
    publicationYear: "2016",
    venue: "CVPR",
    doi: "10.1109/CVPR.2016.90",
    paste: "",
    tldr: "This paper presents a residual learning framework to ease the training of networks that are substantially deeper than those previously used.",
  };

  const pdfText = `
Deep Residual Learning for Image Recognition
Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun
Microsoft Research

Abstract
Deeper neural networks are more difficult to train. We present a residual learning
framework to ease the training of networks that are substantially deeper than those
previously used. We explicitly reformulate the layers as learning residual functions
with reference to the layer inputs, instead of learning unreferenced functions.
We evaluate these residual networks on the ImageNet dataset with a depth of up to 152 layers.
`.trim();

  applyExtractedCard(state, "resnet.pdf", card, [], pdfText);

  assert.equal(state.title, "Deep Residual Learning for Image Recognition");
  assert.equal(state.sciTitleRejected, false);
  assert.match(state.tldr, /residual learning framework/);
});

test("applyExtractedCard: 本文と合わない題名や別の論文の説明は採用しない", () => {
  const state = emptyState({ filename: "resnet.pdf", inboxPdfPath: "/tmp/resnet.pdf", paperDir: "/tmp" });
  const card = {
    title: "Efficacy of mRNA Vaccines in Oncology Patients",
    yearAuthorLine: "2021 · John Doe",
    authors: "John Doe",
    publicationYear: "2021",
    venue: "Nature Medicine",
    doi: "",
    paste: "",
    tldr: "This paper evaluates the clinical efficacy and adverse reactions of mRNA vaccines in pediatric leukemia patients undergoing chemotherapy.",
  };

  const resnetPdfText = `
Deep Residual Learning for Image Recognition
Kaiming He Xiangyu Zhang Shaoqing Ren Jian Sun
Microsoft Research

Abstract
Deeper neural networks are more difficult to train. We present a residual learning
framework to ease the training of networks that are substantially deeper than those
previously used. We explicitly reformulate the layers as learning residual functions
with reference to the layer inputs.
`.trim();

  applyExtractedCard(state, "resnet.pdf", card, [], resnetPdfText);

  // 本文と合わない題名はファイル名に、合わない説明は空に
  assert.equal(state.title, "resnet");
  assert.equal(state.sciTitleRejected, true);
  assert.equal(state.tldr, "");
});


test("isNotebooksFilesView: サイドバーありでも行を持つ表がなければ false", async () => {
  const { isNotebooksFilesView } = await import("./scispace.ts");
  const page = {
    url: () => "https://example.test/folder",
    locator: (selector: string) => {
      assert.match(selector, /table:has\(tr\)/);
      return { first: () => ({ isVisible: async () => false }) };
    },
    getByText: () => { throw new Error("表のない画面でサイドバーを根拠にしない"); },
  } as unknown as import("playwright").Page;
  assert.equal(await isNotebooksFilesView(page, "https://example.test/folder"), false);
});

test("TL;DR 行探索も語中改行の PDF 名を同じ比較関数で認識する", async () => {
  const { readFilesColumnTldr } = await import("./scispace.ts");
  const { runInNewContext } = await import("node:vm");
  const summary = "The paper presents a detailed analysis of quantum error correction and its experimental validation across several computing platforms.";
  const filename = { textContent: "phase2_3_\n0_1.pdf", innerText: "phase2_3_\n0_1.pdf", children: [] as unknown[], parentElement: null as unknown };
  const description = { textContent: summary, innerText: summary, children: [] };
  const row = { innerText: `${filename.innerText}\n${summary}`, children: [filename, description], parentElement: null };
  filename.parentElement = row;
  const page = {
    evaluate: async (code: string) => runInNewContext(code, {
      document: { body: {}, querySelectorAll: (selector: string) => selector.includes("role=") ? [row] : [filename] },
    }),
  } as unknown as import("playwright").Page;
  assert.equal(await readFilesColumnTldr(page, "phase2_3_0_1.pdf"), summary);
});

const agrosShort = "AgROS: A Robot Operating System Based Emulation";
const agrosTitle = `${agrosShort} Tool for Agricultural Robotics`;
const agrosPdf = `Agronomy\nArticle\n${agrosShort}\nTool for Agricultural Robotics\nNaoum Tsolakis, Dimitrios Bechtsis and Dionysis Bochtis\nAbstract\n${"Agricultural robotics and emulation. ".repeat(12)}\ndoi:10.3390/agronomy9070403`;
const agrosWork = { title: agrosTitle, authors: ["Naoum Tsolakis"], year: "2019", venue: "Agronomy", doi: "10.3390/agronomy9070403" };

function agrosState() {
  const state = emptyState({ filename: "agronomy-09-00403.pdf", inboxPdfPath: "/tmp/input.pdf", paperDir: "/tmp" });
  state.filesPaste = `${state.filename}\n${agrosShort}\n2019⋅DOI\njournal`;
  return state;
}

test("AgROS: original DOI plus official title completes a wrapped title without changing raw paste", async () => {
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta, eduShareSciSpaceMetadataPaste } = await import("../scispace-card.ts");
  const state = agrosState();
  const raw = state.filesPaste;
  applyExtractedCard(state, state.filename, extractSciSpaceCardMeta(raw, state.filename), [], agrosPdf);
  await verifySciSpaceBibliography(state, state.filename, agrosPdf, async doi => {
    assert.equal(doi, agrosWork.doi);
    return agrosWork;
  });
  assert.equal(state.title, agrosTitle);
  assert.equal(state.venue, "Agronomy");
  assert.equal(state.doi, agrosWork.doi);
  assert.equal(state.sciTitleRejected, false);
  assert.equal(state.filesPaste, raw);
  const paste = eduShareSciSpaceMetadataPaste(raw, state.filename, { currentTitle: state.title, currentVenue: state.venue });
  assert.match(paste, /Tool for Agricultural Robotics/);
  assert.doesNotMatch(paste, /2019⋅DOI|\njournal/);
});

test("AgROS: unavailable or wrong-DOI official metadata cannot authorize a cropped title", async () => {
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  for (const lookup of [async () => null, async () => ({ ...agrosWork, doi: "10.1234/other" }), async () => ({ ...agrosWork, title: `${agrosShort} Completely Different Study` }), async () => { throw new Error("offline fixture"); }]) {
    const state = agrosState();
    state.title = agrosShort;
    state.venue = "Agronomy";
    await verifySciSpaceBibliography(state, state.filename, agrosPdf, lookup);
    assert.equal(state.title, agrosShort);
    assert.equal(state.venue, "Agronomy");
    assert.equal(state.sciTitleRejected, true);
    assert.equal(usableEduShareTitle(state), "");
  }
});

test("AgROS: uncertain card cannot overwrite a complete title, known venue or DOI", async () => {
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const state = agrosState();
  state.title = agrosTitle;
  state.venue = "Agronomy";
  state.doi = agrosWork.doi;
  const card = extractSciSpaceCardMeta(`${state.filename}\n${agrosShort}\n2019⋅DOI\njournal\n10.1234/unrelated`, state.filename);
  applyExtractedCard(state, state.filename, card, [], agrosPdf);
  await verifySciSpaceBibliography(state, state.filename, agrosPdf, async () => null);
  assert.equal(state.title, agrosTitle);
  assert.equal(state.venue, "Agronomy");
  assert.equal(state.doi, agrosWork.doi);
});

test("outgoing venue cannot use a saved author name or UI label", async () => {
  const { usableEduShareVenue } = await import("./edushare.ts");
  const state = agrosState();
  state.filesPaste = `${state.filename}\n${agrosTitle}\n2019⋅Naoum Tsolakis\nAgronomy`;
  state.venue = "Naoum Tsolakis";
  assert.equal(usableEduShareVenue(state), "Agronomy");
  state.venue = "journal";
  assert.equal(usableEduShareVenue(state), "Agronomy");
});


test("PDF extraction unavailable: preserve existing metadata without a network lookup", async () => {
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const state = agrosState();
  state.title = agrosTitle;
  state.venue = "Agronomy";
  await verifySciSpaceBibliography(state, state.filename, undefined, async () => { throw new Error("must not be called"); });
  assert.equal(state.title, agrosTitle);
  assert.equal(state.venue, "Agronomy");
});
