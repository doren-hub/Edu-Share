import test from "node:test";
import assert from "node:assert/strict";
import { applyExtractedCard, fillMissingSciSpaceTitle } from "./scispace.ts";
import { reconcileMetaFromFilesPaste } from "../scispace-card.ts";
import { emptyState } from "../state.ts";

const fallbackTitle = "Comparing Sparse Matrix Algorithms for Graph Analysis";
const fallbackFirstPage = `${fallbackTitle}
Authors: Jane Smith, Peter Liu
Abstract
We evaluate several sparse matrix algorithms for graph analysis on benchmark problems.`;

function titleFallbackState(filename: string) {
  const state = emptyState({ filename, inboxPdfPath: `/tmp/${filename}`, paperDir: "/tmp" });
  state.title = filename.replace(/\.pdf$/i, "");
  state.sciTitleRejected = true;
  return state;
}

test("fillMissingSciSpaceTitle: PDF と一致する arXiv の題名を先に使う", async () => {
  const state = titleFallbackState("2611.12345v3.pdf");
  const arxivTitle = fallbackTitle.toLowerCase();
  await fillMissingSciSpaceTitle(state, fallbackFirstPage, async () => {
    assert.fail("arXiv で確認できた場合に先頭ページを読み直した");
  }, async (id) => {
    assert.equal(id, "2611.12345");
    return `<entry><title>${arxivTitle}</title></entry>`;
  });
  assert.equal(state.title, arxivTitle);
  assert.equal(state.sciTitleRejected, false);

  const { usableEduShareTitle } = await import("./edushare.ts");
  state.filesPaste = [state.filename, `${arxivTitle} and unsupported words`, "2026⋅Jane Smith"].join("\n");
  assert.equal(reconcileMetaFromFilesPaste(state), false);
  assert.equal(usableEduShareTitle(state), arxivTitle);
});

test("fillMissingSciSpaceTitle: arXiv の題名が一致しない、または取得できない場合は PDF の先頭ページを使う", async () => {
  for (const lookupArxiv of [
    async () => "<entry><title>Comparing Sparse Matrix Algorithms for Climate Change</title></entry>",
    async () => { throw new Error("timeout"); },
  ]) {
    const state = titleFallbackState("2611.12345.pdf");
    await fillMissingSciSpaceTitle(state, fallbackFirstPage, async () => fallbackFirstPage, lookupArxiv);
    assert.equal(state.title, fallbackTitle);
    assert.equal(state.sciTitleRejected, false);
  }
});

test("fillMissingSciSpaceTitle: arXiv 以外で空またはファイル名の題名は PDF の先頭ページで補う", async () => {
  const lookupArxiv = async () => assert.fail("arXiv ID のないファイルを問い合わせた");
  for (const title of ["", "upload"]) {
    const state = titleFallbackState("upload.pdf");
    state.title = title;
    await fillMissingSciSpaceTitle(state, fallbackFirstPage, async () => fallbackFirstPage, lookupArxiv);
    assert.equal(state.title, fallbackTitle);
  }
});

test("fillMissingSciSpaceTitle: 既存の題名を維持する", async () => {
  const existing = titleFallbackState("2611.12345.pdf");
  existing.title = fallbackTitle;
  existing.sciTitleRejected = false;
  await fillMissingSciSpaceTitle(existing, fallbackFirstPage, async () => {
    assert.fail("既存の題名がある場合に先頭ページを読み直した");
  }, async () => assert.fail("既存の題名がある場合に arXiv を問い合わせた"));
  assert.equal(existing.title, fallbackTitle);
  assert.equal(existing.sciTitleFallback, undefined);
});

test("fillMissingSciSpaceTitle: PDF 本文と一致しない先頭ページの候補は採用しない", async () => {
  const state = titleFallbackState("upload.pdf");
  const unrelatedFirstPage = fallbackFirstPage.replace(fallbackTitle, "Quantum Teleportation Across the Danube");
  await fillMissingSciSpaceTitle(state, fallbackFirstPage, async () => unrelatedFirstPage);
  assert.equal(state.title, "upload");
  assert.equal(state.sciTitleRejected, true);
  assert.equal(state.sciTitleFallback, undefined);
});

test("fillMissingSciSpaceTitle: 先頭ページに題名がなく書誌も一致しなければ Edu Share へ題名を渡さない", async () => {
  const state = titleFallbackState("2611.12345v3.pdf");
  state.sciTitleRejected = false;
  state.filesPaste = [state.filename, "Quantum Teleportation Across the Danube", "2026⋅Jane Smith"].join("\n");
  await fillMissingSciSpaceTitle(state, fallbackFirstPage, async () => "", async () =>
    "<entry><title>Quantum Teleportation Across the Danube</title></entry>");
  assert.equal(state.title, "2611.12345v3");
  assert.equal(state.sciTitleRejected, true);
  const { usableEduShareTitle } = await import("./edushare.ts");
  assert.equal(usableEduShareTitle(state), "");
});

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
  const filename = { closest: () => null, textContent: "phase2_3_\n0_1.pdf", innerText: "phase2_3_\n0_1.pdf", children: [] as unknown[], parentElement: null as unknown };
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

test("complete title followed by affiliations or authors remains usable without Crossref", async () => {
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  for (const next of ["Department of Computer Science, University of Tokyo", "Institute for Agricultural Robotics", "John Smith, Jane Doe", "Consortium for Agricultural Robotics"]) {
    const state = agrosState();
    state.title = agrosTitle;
    const pdf = `${agrosTitle}\n${next}\nAbstract\n${"Robotics emulation study. ".repeat(20)}`;
    await verifySciSpaceBibliography(state, state.filename, pdf, async () => { throw new Error("must not be called without DOI"); });
    assert.equal(state.sciTitleRejected, false, next);
    assert.equal(usableEduShareTitle(state), agrosTitle, next);
    await verifySciSpaceBibliography(state, state.filename, `${pdf}\ndoi:${agrosWork.doi}`, async () => null);
    assert.equal(usableEduShareTitle(state), agrosTitle, next);
  }
});


test("Issue #140: complete title followed by an unlabelled abstract remains usable", async () => {
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  for (const abstract of [
    "In this study, we evaluate emulation techniques for agricultural robotics.",
    "In this paper we present a robot emulation framework and evaluate its performance.",
    "On the basis of field experiments, we compare several agricultural robot systems.",
  ]) {
    for (const separator of ["\n", " "]) {
      for (const lookup of [async () => null, async () => { throw new Error("offline fixture"); }]) {
        for (const doi of ["", `\ndoi:${agrosWork.doi}`]) {
          const state = agrosState();
          state.title = agrosTitle;
          state.venue = "Agronomy";
          state.doi = agrosWork.doi;
          const pdf = `${agrosTitle}${separator}${abstract}\n${"Agricultural robotics emulation results. ".repeat(20)}${doi}`;
          await verifySciSpaceBibliography(state, state.filename, pdf, lookup);
          assert.equal(state.sciTitleRejected, false, abstract);
          assert.equal(usableEduShareTitle(state), agrosTitle, abstract);
          assert.equal(state.venue, "Agronomy");
          assert.equal(state.doi, agrosWork.doi);
        }
      }
    }
  }
});

test("Issue #140: genuine prepositional title continuations still require verification", async () => {
  const { titleHasPdfContinuation } = await import("../bibliography.ts");
  for (const ending of ["In Agricultural Robotics", "On Field Emulation", "Tool for Agricultural Robotics"]) {
    assert.equal(titleHasPdfContinuation(agrosShort, `${agrosShort}\n${ending}\nAbstract`), true);
  }
});

test("Issue #147: real basis subtitle is withheld until the original DOI verifies it", async () => {
  const { basisSubtitle: fixture } = await import("../fixtures/basis-context.ts");
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  const full = `${fixture.prefix} ${fixture.subtitle}`;
  const work = { title: full, authors: ["Yoshitaka MORIFUJI"], year: "1994", venue: "Bulletin of Society of Japan Science Teaching", doi: fixture.doi };
  for (const subtitle of [fixture.subtitle, "On the Basis of Conceptual Ecology", fixture.subtitle.toLowerCase()]) {
    for (const separator of ["\n", " "]) {
      // Prose after Abstract must not be mistaken for subtitle context.
      const pdf = `${fixture.prefix}${separator}${subtitle}\nAbstract\nWe examine conceptual ecology. ${"Synthetic body padding. ".repeat(30)}\ndoi:${fixture.doi}`;
      for (const lookup of [async () => null, async () => { throw new Error("offline fixture"); }, async () => ({ ...work, doi: "10.1234/wrong" }), async () => ({ ...work, title: `${fixture.prefix} Unrelated Subtitle` })]) {
        const state = agrosState();
        state.title = fixture.prefix;
        state.filesPaste = `${state.filename}\n${fixture.prefix}\n1994 · Yoshitaka MORIFUJI`;
        state.venue = work.venue;
        state.doi = fixture.doi;
        const raw = state.filesPaste;
        await verifySciSpaceBibliography(state, state.filename, pdf, lookup);
        assert.equal(state.sciTitleRejected, true);
        assert.equal(usableEduShareTitle(state), "");
        assert.equal(state.title, fixture.prefix);
        assert.equal(state.venue, work.venue);
        assert.equal(state.doi, fixture.doi);
        assert.equal(state.filesPaste, raw);
        await verifySciSpaceBibliography(state, state.filename, pdf, async () => work);
        assert.equal(state.sciTitleRejected, false);
        assert.equal(usableEduShareTitle(state), full);
        assert.equal(state.filesPaste, raw);
      }
      const state = agrosState();
      state.title = fixture.prefix;
      await verifySciSpaceBibliography(state, state.filename, pdf.replace(`doi:${fixture.doi}`, ""), async () => { throw new Error("must not look up without original DOI"); });
      assert.equal(usableEduShareTitle(state), "");
    }
  }
});

test("Issue #147: real unlabelled basis abstract remains usable across wrapping and case", async () => {
  const { basisAbstract: fixture } = await import("../fixtures/basis-context.ts");
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  const openings = [fixture.opening, fixture.opening.toUpperCase(), fixture.opening.replace(", we", ",\nwe"), fixture.opening.replace("basis of", "basis\nof")];
  // Synthetic grammar variants supplement the real first-person opening.
  for (const clause of ["this paper presents", "this study examines", "this paper shows", "this study aims", "this paper discusses", "this study has", "we discuss", "we have"]) {
    openings.push(fixture.opening.replace("we propose", `${clause} a synthetic result.`));
  }
  for (const opening of openings) {
    for (const separator of ["\n", " "]) {
      for (const doi of ["", `\ndoi:${fixture.doi}`]) {
        for (const lookup of [async () => null, async () => { throw new Error("offline fixture"); }]) {
          const state = agrosState();
          state.title = fixture.title;
          const pdf = `${fixture.title}${separator}${opening}\n${"Synthetic body padding. ".repeat(30)}${doi}`;
          await verifySciSpaceBibliography(state, state.filename, pdf, lookup);
          assert.equal(state.sciTitleRejected, false, opening);
          assert.equal(usableEduShareTitle(state), fixture.title);
        }
      }
    }
  }
});

test("Issue #161: author boundary withholds a subtitle prefix but direct abstract remains usable", async () => {
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  const title = "Synthetic Robot Emulation Study";
  for (const separator of ["\n", " "]) {
    for (const withAuthors of [false, true]) {
      const state = emptyState({ filename: "synthetic.pdf", inboxPdfPath: "/tmp/synthetic.pdf", paperDir: "/tmp" });
      state.title = title;
      const pdf = `${title}${separator}On the basis of synthetic field trials\n${withAuthors ? "Alice Example, Bob Sample\n" : ""}We compare synthetic robot systems.`;
      await verifySciSpaceBibliography(state, state.filename, pdf, async () => {
        assert.fail("Synthetic text has no DOI; no lookup is permitted");
      });
      assert.equal(Boolean(state.sciTitleRejected), withAuthors);
      assert.equal(usableEduShareTitle(state), withAuthors ? "" : title);
      assert.equal(state.title, title);
    }
  }
});

// Offline reproduction: searching mounts the row; clearing search unmounts it.
test("virtualized Files row: terminal, usable and pending TL;DR (offline DOM)", { timeout: 120_000 }, async t => {
  const { chromium } = await import("playwright");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { captureSciSpaceCardMeta, readFilesColumnTldr } = await import("./scispace.ts");
  const browser = await chromium.launch();
  const dir = mkdtempSync(join(tmpdir(), "scispace-files-"));
  const filename = "japanese_paper.pdf";
  const title = "日本語の論文における学習支援の検討";
  const summary = "This paper presents a detailed analysis of learning support and reports experimental validation of the proposed educational methods.";
  const folderUrl = "https://example.test/folders/offline";
  const row = `<tr data-slot="table-row" data-row-id="RID" data-index="0" data-item-index="0">
    <td data-slot="table-cell"><button role="checkbox" aria-label="Select row" data-test-id="folder-table-row-checkbox-RID"></button></td>
    <td data-slot="table-cell"><div>
      <a target="_blank" data-test-id="folder-record-title-RID" href="https://scispace.com/records/offline-RID">${filename}</a>
      <div><small data-design-system="small">${title}</small>
        <div><div><span data-design-system="small">2024</span><span>⋅</span><span data-design-system="small">山田 太郎</span></div>
        <small data-design-system="small">教育工学論文誌</small></div>
        <div><span data-test-id="folder-record-type-RID">PDF UPLOAD</span><span data-design-system="tiny">Uploaded on 13 Nov 2026</span></div>
      </div></div></td>
    <td data-slot="table-cell"><div><div><div><div data-markdown-renderer-content="true"><div><p id="tldr"></p></div></div></div></div></td>
  </tr>`;
  try {
    for (const kind of ["unanswered", "summary", "pending"] as const) {
      await t.test(kind, async () => {
        const context = await browser.newContext();
        let recordRequests = 0;
        const searches: string[] = [];
        await context.route("**/*", async route => {
          if (route.request().url() !== folderUrl) {
            recordRequests++;
            if (route.request().url() === "https://scispace.com/records/offline-RID") {
              await route.fulfill({ contentType: "text/html", body: '<h1>Files</h1><meta property="og:title" content="Files"><meta property="og:description" content=""><meta name="description" content=""><p>e.g., Janis &amp; Terwilliger,</p>' });
            } else {
              await route.abort();
            }
            return;
          }
          await route.fulfill({ contentType: "text/html; charset=utf-8", body: `
            <div style="margin-left:250px"><button>Upload PDFs</button><button>Sort</button>
              <button aria-label="Search files" data-test-id="folder-toolbar-search-trigger"
                onclick="document.querySelector('input').hidden=false">Search</button>
              <input hidden data-test-id="folder-toolbar-search-input" placeholder="Search by file name">
            </div><div>Files (218)</div>
            <table><thead><tr><th></th><th>Name</th><th>TL;DR</th></tr></thead><tbody id="rows">
              <tr><td></td><td>unrelated.pdf</td><td>Unrelated paper</td></tr>
            </tbody></table>
            <script>
              window.searches = [];
              const input = document.querySelector('input');
              input.addEventListener('input', () => {
                window.searches.push(input.value);
                window.recordSearch(input.value);
                clearTimeout(window.pending);
                document.querySelector('[data-row-id="RID"]')?.remove();
                if (!input.value) return;
                document.querySelector('#rows').insertAdjacentHTML('afterbegin', ${JSON.stringify(row)});
                document.querySelector('#tldr').textContent = ${JSON.stringify(kind === "unanswered" ? "Not addressed in the paper." : kind === "summary" ? summary : "")};
                if (${kind === "pending"}) window.pending = setTimeout(() => {
                  document.querySelector('#tldr').textContent = ${JSON.stringify(summary)};
                }, 4000);
              });
            </script>` });
        });
        const page = await context.newPage();
        try {
          await page.exposeFunction("recordSearch", (query: string) => searches.push(query));
          await page.goto(folderUrl);
          await page.locator('input').evaluate((el: HTMLInputElement) => {
            el.value = "japanese_paper";
            el.dispatchEvent(new Event("input"));
          });
          assert.equal(await readFilesColumnTldr(page, filename), kind === "unanswered" ? "Not addressed in the paper." : kind === "summary" ? summary : "");
          await page.locator('input').evaluate((el: HTMLInputElement) => {
            el.value = "";
            el.dispatchEvent(new Event("input"));
            (window as unknown as { searches: string[] }).searches = [];
          });
          assert.equal(await page.getByText(filename, { exact: true }).count(), 0);
          searches.length = 0;
          const state = emptyState({ filename, inboxPdfPath: "", paperDir: dir });
          state.tldr = "Not addressed in the paper.";
          const started = Date.now();
          await captureSciSpaceCardMeta(page, { folderUrl, filename, paperDir: dir, state });
          assert.ok(Date.now() - started < 30_000, "terminal response must not wait 60 seconds");
          if (kind === "pending") assert.ok(Date.now() - started >= 4000, "empty cell must wait for generation");
          assert.equal(state.lastError, "");
          assert.equal(state.title, title);
          const card = (await import("../scispace-card.ts")).extractSciSpaceCardMeta(state.filesPaste, filename);
          assert.equal(card.authors, "山田 太郎");
          assert.equal(card.publicationYear, "2024");
          assert.equal(state.venue, "教育工学論文誌");
          assert.match(state.filesPaste, /japanese_paper\.pdf/);
          assert.equal(state.tldr, kind === "unanswered" ? "" : summary);
          assert.equal(recordRequests, kind === "unanswered" ? 1 : 0, "unanswered summary uses the existing record fallback");
          assert.ok(searches.length > 0 && searches.every(q => q.length > 0), "capture must preserve the file search");
        } finally {
          await context.close();
        }
      });
    }
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("issue 322: Files wins over body fragments; unsupported body titles stay rejected", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  const filename = "japanese_paper.pdf";
  const title = "日本語の論文における学習支援の検討";
  const fragments = [
    "e.g., Janis & Terwilliger,",
    "J. Natl. Inst. Public Health, 66 (6) : 2017",
    "J. Natl. Inst. Public Health, 69 (5) : 2020",
    "Vibrio parahaemolyticus",
    "本稿は、学習支援についての学術研究をレビューすることを目",
  ];
  const pdf = `${title}\n山田 太郎\n要旨\n${fragments.join("\n")}\n${"学習支援について検討した。".repeat(30)}`;
  for (const fragment of fragments) {
    for (const filesPaste of ["", `${filename}\n${title}\nTL;DR\nNot addressed in the paper.`]) {
      for (const text of [undefined, "", "[scanned]", pdf]) {
        const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
        state.filesPaste = filesPaste;
        state.title = fragment;
        const card = { ...extractSciSpaceCardMeta(fragment, filename), title: fragment };
        applyRecordPageCard(state, filename, card, "", text);
        const accepted = Boolean(filesPaste) && (text === undefined || text === pdf);
        assert.equal(usableEduShareTitle(state), accepted ? title : "", fragment);
        assert.equal(state.sciTitleRejected, !accepted);
        assert.equal(state.filesPaste, filesPaste);
      }
    }
  }
});

test("issue 322: complete English and Japanese PDF titles and valid headings survive", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  const filename = "paper.pdf";
  for (const title of ["Deep Residual Learning for Image Recognition", "腸炎ビブリオ Vibrio parahaemolyticus の増殖に関する研究"]) {
    const pdf = `${title}\nAlice Example\nAbstract\n${"Experimental results and discussion of learning and public health. ".repeat(20)}`;
    for (const heading of ["", title]) {
      const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
      if (heading) state.filesPaste = `${filename}\n別の日本語論文における学習支援の検討`;
      applyRecordPageCard(state, filename, extractSciSpaceCardMeta(title, filename), heading, pdf);
      assert.equal(usableEduShareTitle(state), title);
      assert.equal(state.sciTitleRejected, false);
    }
    const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
    const card = extractSciSpaceCardMeta(title, filename);
    applyRecordPageCard(state, filename, card, "");
    assert.equal(usableEduShareTitle(state), "", "body requires PDF evidence");
    applyRecordPageCard(state, filename, card, title);
    assert.equal(usableEduShareTitle(state), title, "heading keeps no-PDF behavior");
  }
});


test("issue 322: a record heading does not shorten an already complete saved title", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");
  const state = emptyState({ filename: "paper.pdf", inboxPdfPath: "", paperDir: "/tmp" });
  const heading = "AgROS: A Robot Operating System Based Emulation";
  state.title = `${heading} Tool for Agricultural Robotics`;
  applyRecordPageCard(state, state.filename, extractSciSpaceCardMeta(heading, state.filename), heading);
  assert.equal(state.title, `${heading} Tool for Agricultural Robotics`);
});


test("issue 322: missing heading preserves a saved complete title with empty, shorter or different Files titles", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  const title = "Complete Verified Article Title for Educational Robotics";
  for (const filesTitle of ["", "Complete Verified Article Title", "Another Valid Article Title"] ) {
    for (const pdfText of [undefined, `${title}\nAlice Example\nAbstract\n${"Educational robotics experimental results. ".repeat(20)}`]) {
      const state = emptyState({ filename: "paper.pdf", inboxPdfPath: "", paperDir: "/tmp" });
      state.title = title;
      state.filesPaste = filesTitle ? `paper.pdf\n${filesTitle}\nTL;DR\nNot addressed in the paper.` : "";
      applyRecordPageCard(state, state.filename, extractSciSpaceCardMeta("e.g., Janis & Terwilliger,", state.filename), "", pdfText);
      assert.equal(state.title, title);
      assert.equal(usableEduShareTitle(state), title);
      assert.equal(state.sciTitleRejected, false);
    }
  }
});


test("issue 322: an italic fragment in Files cannot bypass PDF title validation", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");
  const { usableEduShareTitle } = await import("./edushare.ts");
  const fragment = "Vibrio parahaemolyticus";
  const title = `腸炎ビブリオ ${fragment} の増殖に関する研究`;
  const pdf = `${title}\n山田 太郎\n要旨\n${"腸炎ビブリオの増殖について調査した。".repeat(20)}`;
  for (const bodyTitle of [fragment, title]) {
    const state = emptyState({ filename: "paper.pdf", inboxPdfPath: "", paperDir: "/tmp" });
    state.title = fragment;
    state.filesPaste = `paper.pdf\n${fragment}\nTL;DR\nNot addressed in the paper.`;
    applyRecordPageCard(state, state.filename, extractSciSpaceCardMeta(bodyTitle, state.filename), "", pdf);
    assert.equal(usableEduShareTitle(state), bodyTitle === title ? title : "");
    assert.equal(state.sciTitleRejected, bodyTitle !== title);
  }
});

test("issue 335: restoreFolderFilesTable は検索欄に文字や 0 件表示があるとき検索欄を空にする", async () => {
  const { restoreFolderFilesTable } = await import("./scispace.ts");
  let searchVal = "UnmatchedTitle";
  let hasNoResults = true;
  let filledValue = "";

  const page = {
    url: () => "https://example.test/folder",
    locator: (selector: string) => {
      if (selector.includes("folder-toolbar-search-input")) {
        return {
          first: () => ({
            isVisible: async () => true,
            inputValue: async () => searchVal,
            fill: async (val: string) => {
              filledValue = val;
              searchVal = val;
              hasNoResults = val !== "";
            },
          }),
        };
      }
      if (selector.includes("table:has(tr)")) {
        return {
          first: () => ({
            isVisible: async () => searchVal === "",
          }),
        };
      }
      if (selector === "body") {
        return {
          innerText: async () =>
            searchVal ? `There are no results for "${searchVal}"` : "Upload PDFs Files (10) Uploaded on",
        };
      }
      return {
        first: () => ({
          isVisible: async () => false,
        }),
      };
    },
    getByRole: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    getByPlaceholder: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    keyboard: {
      press: async () => {},
    },
    getByText: (pattern: RegExp | string) => ({
      first: () => ({
        isVisible: async () => {
          if (typeof pattern === "object" && pattern.test("There are no results for")) {
            return hasNoResults;
          }
          return false;
        },
      }),
    }),
  } as unknown as import("playwright").Page;

  await restoreFolderFilesTable(page, "https://example.test/folder");
  assert.equal(filledValue, "");
  assert.equal(searchVal, "");
});

test("issue 335: restoreFolderFilesTable は検索欄を空にしても表が戻らない場合に無限ループせず終了する", async () => {
  const { restoreFolderFilesTable } = await import("./scispace.ts");
  let clearCount = 0;

  const page = {
    url: () => "https://example.test/folder",
    locator: (selector: string) => {
      if (selector.includes("folder-toolbar-search-input")) {
        return {
          first: () => ({
            isVisible: async () => true,
            inputValue: async () => "StuckQuery",
            fill: async () => {
              clearCount++;
            },
          }),
        };
      }
      return {
        first: () => ({
          isVisible: async () => false,
        }),
        innerText: async () => "",
      };
    },
    getByRole: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    getByPlaceholder: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    keyboard: {
      press: async () => {},
    },
    getByText: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
  } as unknown as import("playwright").Page;

  await restoreFolderFilesTable(page, "https://example.test/folder");
  // Exactly 1 clear attempt is made, no infinite mutual recursion
  assert.equal(clearCount, 1);
});

test("issue 335: filterFilesList は全検索語が0件のとき Load More やスクロールをスキップして短時間で打ち切る", async () => {
  const { filterFilesList } = await import("./scispace.ts");
  let loadMoreChecked = false;
  let scrollChecked = false;
  let currentSearch = "";
  const queriesRan: string[] = [];

  const page = {
    url: () => "https://example.test/folder",
    locator: (selector: string) => {
      if (selector.includes("folder-toolbar-search-input")) {
        return {
          first: () => ({
            isVisible: async () => true,
            inputValue: async () => currentSearch,
            fill: async (val: string) => {
              currentSearch = val;
              if (val) queriesRan.push(val);
            },
          }),
        };
      }
      if (selector.includes("table:has(tr)")) {
        return {
          first: () => ({
            isVisible: async () => currentSearch === "",
          }),
        };
      }
      return {
        first: () => ({
          isVisible: async () => false,
        }),
        innerText: async () =>
          currentSearch ? `There are no results for "${currentSearch}"` : "Upload PDFs Files (10) Uploaded on",
      };
    },
    getByRole: (role: string, opts?: { name: RegExp }) => ({
      first: () => ({
        isVisible: async () => {
          if (opts?.name && opts.name.test("Upload PDFs")) return true;
          if (opts?.name && opts.name.test("Load More")) {
            loadMoreChecked = true;
          }
          return false;
        },
      }),
    }),
    getByPlaceholder: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    keyboard: {
      press: async () => {},
    },
    mouse: {
      wheel: async () => {
        scrollChecked = true;
      },
    },
    getByText: (pattern: RegExp | string) => ({
      first: () => ({
        isVisible: async () => {
          if (typeof pattern === "object" && pattern.test("Files")) return true;
          if (typeof pattern === "object" && pattern.test("Uploaded on")) return currentSearch === "";
          if (typeof pattern === "object" && pattern.test("There are no results for")) {
            return currentSearch !== "";
          }
          return false;
        },
        scrollIntoViewIfNeeded: async () => {},
      }),
    }),
  } as unknown as import("playwright").Page;

  const loggedLines: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (...args: unknown[]) => boolean }).write = (
    chunk: unknown,
    ...args: unknown[]
  ) => {
    loggedLines.push(String(chunk));
    return (originalStdoutWrite as unknown as (...args: unknown[]) => boolean)(chunk, ...args);
  };
  try {
    await filterFilesList(page, "https://example.test/folder", "missing.pdf", "Missing Title");
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  // Queries were actually attempted
  assert.ok(queriesRan.length >= 2);
  // All queries were 0 results, so Load More and scroll wheel must be skipped completely
  assert.equal(loadMoreChecked, false);
  assert.equal(scrollChecked, false);
  assert.equal(currentSearch, "");
  assert.ok(loggedLines.some((l) => l.includes("SciSpace: Files 一覧に見つかりません（missing.pdf）")));
});

test("issue 335: filterFilesList は検索0件でも検索欄を空にして次の語へ進み、どの戻り方でも検索欄を空にする", async () => {
  const { filterFilesList } = await import("./scispace.ts");
  const searchesTried: string[] = [];
  let currentSearch = "";

  const page = {
    url: () => "https://example.test/folder",
    locator: (selector: string) => {
      if (selector.includes("folder-toolbar-search-input")) {
        return {
          first: () => ({
            isVisible: async () => true,
            inputValue: async () => currentSearch,
            fill: async (val: string) => {
              currentSearch = val;
              searchesTried.push(val);
            },
          }),
        };
      }
      if (selector.includes("table:has(tr)")) {
        return {
          first: () => ({
            isVisible: async () => currentSearch === "",
          }),
        };
      }
      if (selector === "body") {
        return {
          innerText: async () =>
            currentSearch ? `There are no results for "${currentSearch}"` : "Upload PDFs Files (10) Uploaded on",
        };
      }
      return {
        first: () => ({
          isVisible: async () => false,
        }),
      };
    },
    getByRole: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    getByPlaceholder: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    keyboard: {
      press: async () => {},
    },
    getByText: (pattern: RegExp | string) => ({
      first: () => ({
        isVisible: async () => {
          if (typeof pattern === "object" && pattern.test("There are no results for")) {
            return currentSearch !== "";
          }
          return false;
        },
        scrollIntoViewIfNeeded: async () => {},
      }),
    }),
    mouse: {
      wheel: async () => {},
    },
  } as unknown as import("playwright").Page;

  await filterFilesList(page, "https://example.test/folder", "missing_report.pdf", "日本語報告書の長い題名テキスト");

  // Several search queries tried
  assert.ok(searchesTried.length > 2);
  // The final search query is cleared ("")
  assert.equal(currentSearch, "");
});

test("issue 335: filterFilesList は例外発生時でも finally で検索欄を空にする", async () => {
  const { filterFilesList } = await import("./scispace.ts");
  let currentSearch = "";
  let clearInvoked = false;

  const page = {
    url: () => "https://example.test/folder",
    locator: (selector: string) => {
      if (selector.includes("folder-toolbar-search-input")) {
        return {
          first: () => ({
            isVisible: async () => true,
            inputValue: async () => currentSearch,
            fill: async (val: string) => {
              currentSearch = val;
              if (val === "") clearInvoked = true;
            },
          }),
        };
      }
      if (selector.includes("table:has(tr)")) {
        return {
          first: () => ({
            isVisible: async () => currentSearch === "",
          }),
        };
      }
      if (selector === "body") {
        return {
          innerText: async () =>
            currentSearch ? `Some partial results for "${currentSearch}"` : "Upload PDFs Files (10) Uploaded on",
        };
      }
      return {
        first: () => ({
          isVisible: async () => false,
        }),
      };
    },
    getByRole: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    getByPlaceholder: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    keyboard: {
      press: async () => {},
    },
    mouse: {
      wheel: async () => {
        throw new Error("Mouse failure during scroll");
      },
    },
    getByText: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
  } as unknown as import("playwright").Page;

  await assert.rejects(
    () => filterFilesList(page, "https://example.test/folder", "crash.pdf", "Crash Test Title"),
    /Mouse failure during scroll/,
  );
  assert.equal(clearInvoked, true);
  assert.equal(currentSearch, "");
});

test("issue 335: waitUntilSpecifiedFolderReady は0件表示または検索語があるとき検索欄を空にして表を復元する", async () => {
  const { waitUntilSpecifiedFolderReady } = await import("./scispace.ts");
  let searchVal = "LeftoverSearch";
  let hasTable = false;

  const page = {
    isClosed: () => false,
    evaluate: async () => true,
    goto: async () => {},
    url: () => "https://example.test/folder",
    title: async () => "Folder Title",
    locator: (selector: string) => {
      if (selector.includes("folder-toolbar-search-input")) {
        return {
          first: () => ({
            isVisible: async () => true,
            inputValue: async () => searchVal,
            fill: async (val: string) => {
              searchVal = val;
              if (val === "") hasTable = true;
            },
          }),
        };
      }
      if (selector.includes("table:has(tr)")) {
        return {
          first: () => ({
            isVisible: async () => hasTable,
          }),
        };
      }
      return {
        first: () => ({
          isVisible: async () => false,
        }),
        innerText: async () =>
          searchVal
            ? "Upload PDFs Files (10) Sort There are no results for LeftoverSearch"
            : "Upload PDFs Files (10) Uploaded on",
      };
    },
    getByRole: (role: string, opts?: { name: RegExp }) => ({
      first: () => ({
        isVisible: async () => {
          if (opts?.name && opts.name.test("Upload PDFs")) return true;
          return false;
        },
      }),
    }),
    getByPlaceholder: () => ({
      first: () => ({
        isVisible: async () => false,
      }),
    }),
    keyboard: {
      press: async () => {},
    },
    getByText: (pattern: RegExp | string) => ({
      first: () => ({
        isVisible: async () => {
          if (typeof pattern === "object" && pattern.test("Files")) return true;
          if (typeof pattern === "object" && pattern.test("There are no results for")) return searchVal !== "";
          return false;
        },
      }),
    }),
  } as unknown as import("playwright").Page;

  await waitUntilSpecifiedFolderReady(page, "https://example.test/folder");
  assert.equal(searchVal, "");
  assert.equal(hasTable, true);
});

test("issue 337: isRecordPageConfirmedForPaper はファイル名または題名が出ていることのみを今の論文として確認する", async () => {
  const { isRecordPageConfirmedForPaper } = await import("./scispace.ts");
  const filename = "food_science_study.pdf";
  const knownTitle = "Study on Nutritional Properties of Food";
  const pdfText = `${knownTitle}\nAlice Food\nAbstract\n${"Analysis of nutritional properties in food science. ".repeat(5)}`;

  // 1. ファイル名（または stem）が出ている
  assert.equal(isRecordPageConfirmedForPaper("Title food_science_study.pdf SciSpace", filename), true);
  assert.equal(isRecordPageConfirmedForPaper("Title food_science_study SciSpace", filename), true);

  // 2. 既知の題名が出ている
  assert.equal(
    isRecordPageConfirmedForPaper("Some content with Study on Nutritional Properties of Food", filename, { knownTitle }),
    true,
  );

  // 3. 見出しが PDF 本文でグラウンディングされている
  assert.equal(
    isRecordPageConfirmedForPaper(
      "h1: Study on Nutritional Properties of Food",
      filename,
      { heading: knownTitle, pdfText },
    ),
    true,
  );

  // 4. 直前の別論文（Lancet）の内容のみ残っている場合は false
  assert.equal(
    isRecordPageConfirmedForPaper(
      "The Lancet: Global burden of cardiovascular disease\n10.1016/S0140-6736(16)32380-7\nwww.thelancet.com",
      filename,
      { knownTitle, pdfText, heading: "Global burden of cardiovascular disease" },
    ),
    false,
  );
});

test("issue 337: applyRecordPageCard は「ページの文字に別の論文の DOI があり、PDF の文字にはない」場合 DOI を保存しない", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");

  const filename = "food_study.pdf";
  const foodTitle = "Study on Nutritional Properties of Food";
  const foodPdf = `${foodTitle}\nBob Smith\nAbstract\n${"We evaluate nutritional values in food science and agriculture. ".repeat(3)}\n`;

  const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  // 個別ページの文字に、直前の論文 A（Lancet）の DOI が残っている
  const foreignDoi = "10.1016/S0140-6736(16)32380-7";
  const pageRaw = `${filename}\n${foodTitle}\n2023 · Bob Smith\nFood Science\n${foreignDoi}`;
  const card = extractSciSpaceCardMeta(pageRaw, filename);

  applyRecordPageCard(state, filename, card, foodTitle, foodPdf);

  // PDF の本文にない別論文の DOI は保存されない
  assert.equal(state.doi, "");
});

test("issue 337: applyRecordPageCard は「PDF の文字にある DOI」は保存する（かっこを含む完全な DOI）", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");

  const filename = "lancet_paper.pdf";
  const title = "Global Burden of Disease Study";
  const lancetDoi = "10.1016/S0140-6736(16)32380-7";
  const lancetPdf = `${title}\nChristopher Murray\nAbstract\n${"Global disease burden study across 188 countries. ".repeat(3)}\nDOI: ${lancetDoi}\n`;

  const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  const pageRaw = `${filename}\n${title}\n2016 · Christopher Murray\nThe Lancet\n${lancetDoi}`;
  const card = extractSciSpaceCardMeta(pageRaw, filename);

  applyRecordPageCard(state, filename, card, title, lancetPdf);

  // PDF にあるかっこを含む DOI は途中で切れずにそのまま保存される
  assert.equal(state.doi, lancetDoi);
});

test("issue 337: applyRecordPageCard は途中で切れた DOI は保存しない", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");

  const filename = "paper.pdf";
  const title = "Sample Research Paper";
  const truncatedDoi = "10.1016/S0140-6736(16";
  const pdf = `${title}\nAuthor Name\nAbstract\n${"Sample abstract text for paper analysis. ".repeat(3)}\n${truncatedDoi}\n`;

  const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  const card = extractSciSpaceCardMeta(`${filename}\n${title}\n${truncatedDoi}`, filename);

  applyRecordPageCard(state, filename, card, title, pdf);

  // 途中で切れた閉じていないかっこで終わる DOI は保存されない
  assert.equal(state.doi, "");
});

test("issue 337: isAuthorGroundedInPdfFirstPage と groundedAuthorsFromRecordCard は PDF 先頭の人名のみ抽出し本文語句を除外する", async () => {
  const { isAuthorGroundedInPdfFirstPage, groundedAuthorsFromRecordCard } = await import("./scispace.ts");
  const title = "Investigation of Polymer Dual Gelation Mechanism";
  const pdfText = `${title}\nTaro Yamada, Jiro Suzuki\nAbstract\nIn contrast to standard processes, dual gelation occurs at the 95th and 99th percentiles.\n${"Detailed research content for meeting minimum pdf text length. ".repeat(4)}`;

  // 1. 本文語句は人名ではない、または先頭著者に該当しないため false
  assert.equal(isAuthorGroundedInPdfFirstPage("contrast", pdfText, title), false);
  assert.equal(isAuthorGroundedInPdfFirstPage("dual gelation", pdfText, title), false);
  assert.equal(isAuthorGroundedInPdfFirstPage("the 95th and 99th percentiles", pdfText, title), false);

  // 2. 本文先頭の人名は true
  assert.equal(isAuthorGroundedInPdfFirstPage("Taro Yamada", pdfText, title), true);
  assert.equal(isAuthorGroundedInPdfFirstPage("Jiro Suzuki", pdfText, title), true);

  // 3. 別論文の著者は false
  assert.equal(isAuthorGroundedInPdfFirstPage("Christopher Murray", pdfText, title), false);

  // 4. groundedAuthorsFromRecordCard の複合カンマ区切り処理
  const mixed = "Taro Yamada, dual gelation, Jiro Suzuki, Christopher Murray";
  assert.equal(groundedAuthorsFromRecordCard(mixed, pdfText, title), "Taro Yamada, Jiro Suzuki");
});

test("issue 337: applyRecordPageCard はページ全体の文字から取った著者について PDF 先頭ページにある名前だけ採用し本文語句を除外する", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");

  const filename = "gelation_study.pdf";
  const title = "Investigation of Polymer Dual Gelation Mechanism";
  const realAuthor = "Taro Yamada";
  const pdfText = `${title}\n${realAuthor}\nAbstract\nIn contrast to standard processes, dual gelation occurs at the 95th and 99th percentiles.\n${"Detailed research content for meeting minimum pdf text length. ".repeat(4)}`;

  // 1. 本文語句 contrast, dual gelation, the 95th and 99th percentiles が著者行として現れた場合
  for (const junkAuthor of ["contrast", "dual gelation", "the 95th and 99th percentiles"]) {
    const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
    const card = extractSciSpaceCardMeta(`${filename}\n${title}\n2023 · ${junkAuthor}`, filename);
    applyRecordPageCard(state, filename, card, title, pdfText);
    // 本文語句はグラウンディングされず除外され、venue等の誤判定にも使われない
    assert.equal(state.venue, "");
    // 保存された state.filesPaste に本文語句が入らない
    assert.ok(!state.filesPaste.includes(junkAuthor));
    assert.equal(extractSciSpaceCardMeta(state.filesPaste, filename).authors, "");
  }

  // 2. 正規の著者 Taro Yamada がページ文字から取れ、PDF 先頭にある場合
  const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  const validCard = extractSciSpaceCardMeta(`${filename}\n${title}\n2023 · ${realAuthor}\nPolymer Journal`, filename);
  applyRecordPageCard(state, filename, validCard, title, pdfText);
  // 正規の著者は採用される
  assert.equal(state.venue, "Polymer Journal");
  assert.equal(extractSciSpaceCardMeta(state.filesPaste, filename).authors, realAuthor);
  assert.ok(state.filesPaste.includes(realAuthor));

  // 3. 別の論文の著者がページ文字から取れたが、今の論文の PDF 先頭にない場合
  const stateForeign = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  const foreignCard = extractSciSpaceCardMeta(`${filename}\n${title}\n2023 · Christopher Murray`, filename);
  applyRecordPageCard(stateForeign, filename, foreignCard, title, pdfText);
  // PDF 先頭にない別論文の著者は除外され、state.filesPaste に入らない
  assert.ok(!stateForeign.filesPaste.includes("Christopher Murray"));
  assert.equal(extractSciSpaceCardMeta(stateForeign.filesPaste, filename).authors, "");
});

test("issue 337: applyRecordPageCard は pdfText が未定義でも既存の state.filesPaste 著者を破壊しない", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");

  const filename = "existing_paper.pdf";
  const title = "Existing Research Paper";
  const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  state.filesPaste = `${filename}\n${title}\n2022 · Alice Brown\nExisting Journal`;

  const card = extractSciSpaceCardMeta(`${filename}\n${title}\n2022 · Bob Green\nExisting Journal`, filename);
  applyRecordPageCard(state, filename, card, title, undefined);

  // 既存の Files 由来の著者が保持される
  const parsed = extractSciSpaceCardMeta(state.filesPaste, filename);
  assert.equal(parsed.authors, "Alice Brown");
});

test("issue 337: applyRecordPageCard は Files カードに著者のみ無く掲載等がある場合も他の行を壊さず著者を補う", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const { extractSciSpaceCardMeta } = await import("../scispace-card.ts");

  const filename = "poly_study.pdf";
  const title = "Polymer Characteristics";
  const realAuthor = "Taro Yamada";
  const pdfText = `${title}\n${realAuthor}\nAbstract\nPolymer properties analysis.\n${"More background text for length requirements. ".repeat(4)}`;

  const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  // Files 由来の行にタイトルと掲載誌のみあり、著者が無い状態
  state.filesPaste = `${filename}\n${title}\nPolymer Journal`;

  const card = extractSciSpaceCardMeta(`${filename}\n${title}\n2023 · ${realAuthor}\nPolymer Journal`, filename);
  applyRecordPageCard(state, filename, card, title, pdfText);

  // 著者 Taro Yamada が補われ、タイトルと掲載誌も維持される
  const parsed = extractSciSpaceCardMeta(state.filesPaste, filename);
  assert.equal(parsed.authors, realAuthor);
  assert.equal(parsed.venue, "Polymer Journal");
});

test("issue 337: fillMetaFromRecordPage はページを確認できない場合にメタ取得をスキップし state を変更しない", async () => {
  const { fillMetaFromRecordPage } = await import("./scispace.ts");
  const filename = "food_study.pdf";
  const title = "Study on Nutritional Properties of Food";
  const pdfText = `${title}\nBob Smith\nAbstract\n${"Nutritional analysis content for food science research. ".repeat(4)}\n`;

  const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  state.title = title;

  // 直前の別論文（Lancet）の内容が表示されているモックページ
  const mockPage = {
    goto: async () => {},
    locator: (selector: string) => {
      const el = {
        first: () => el,
        innerText: async () => "Global burden of cardiovascular disease\n10.1016/S0140-6736(16)32380-7\nwww.thelancet.com",
        textContent: async () => "Global burden of cardiovascular disease",
        getAttribute: async (attr: string) => {
          if (attr === "content") return "The Lancet global burden study description";
          return "";
        },
      };
      return el;
    },
    title: async () => "Global Burden of Disease - The Lancet",
    evaluate: async () => "Global burden of cardiovascular disease\n10.1016/S0140-6736(16)32380-7\nwww.thelancet.com",
    waitForTimeout: async () => {},
  } as unknown as import("playwright").Page;

  const result = await fillMetaFromRecordPage(mockPage, state, filename, pdfText, { initialWaitMs: 0, pollTimeoutMs: 10 });

  // 確認できないページからは何も返さず、state も汚染されない
  assert.deepEqual(result, {});
  assert.equal(state.title, title);
  assert.equal(state.doi, "");
  assert.equal(state.tldr, "");
  assert.equal(state.filesPaste, "");
});

test("issue 337: verifySciSpaceBibliography は公式書誌で題名と照合できた DOI（candidateDoi）のみ保存する", async () => {
  const { verifySciSpaceBibliography } = await import("./scispace.ts");

  const filename = "food_study.pdf";
  const foodTitle = "Study on Nutritional Properties of Food";
  // PDF 本文には明示的な DOI 文字列が印刷されていないケース（非スキャンの十分な本文）
  const pdfText = `${foodTitle}\nBob Smith\nAbstract\n${"We evaluate nutritional values in food science and agriculture. ".repeat(4)}\n`;

  const genuineDoi = "10.1016/j.foodchem.2023.10001";
  const genuineWork = { title: foodTitle, authors: ["Bob Smith"], year: "2023", venue: "Food Chemistry", doi: genuineDoi };

  const foreignDoi = "10.1016/S0140-6736(16)32380-7";
  const foreignWork = { title: "Global Burden of Disease", authors: ["Christopher Murray"], year: "2016", venue: "The Lancet", doi: foreignDoi };

  // 1. 直前の論文の DOI（foreignDoi）を candidateDoi として渡しても、書誌題名が一致しないため保存されない
  const stateForeign = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  stateForeign.title = foodTitle;
  await verifySciSpaceBibliography(stateForeign, filename, pdfText, async (doi) => {
    assert.equal(doi, foreignDoi);
    return foreignWork;
  }, foreignDoi);
  assert.equal(stateForeign.doi, "");

  // 2. 本論文の真の DOI（genuineDoi）を candidateDoi として渡すと、公式書誌題名と一致するため保存される
  const stateGenuine = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  stateGenuine.title = foodTitle;
  await verifySciSpaceBibliography(stateGenuine, filename, pdfText, async (doi) => {
    assert.equal(doi, genuineDoi);
    return genuineWork;
  }, genuineDoi);
  assert.equal(stateGenuine.doi, genuineDoi);
});

test("issue 339: applyRecordPageCard は参考文献の一覧にだけある DOI を保存せず、先頭ページの DOI を保存する", async () => {
  const { applyRecordPageCard } = await import("./scispace.ts");
  const filename = "preprint_sample.pdf";
  const title = "Neural Processing Preprint";
  const zenodoDoi = "10.5281/zenodo.1234567";
  const realDoi = "10.1016/j.jcp.2024.001";

  // 1. 参考文献にしか DOI がない場合（プレプリント）: DOI は空のまま
  const preprintPdf = `
${title}
Alice Smith
Abstract
Algorithm description.
${"Background content for testing length. ".repeat(4)}
References
[1] Software library https://doi.org/${zenodoDoi}
`.trim();

  const state1 = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  state1.title = title;
  const card1 = {
    title,
    yearAuthorLine: "2024 · Alice Smith",
    authors: "Alice Smith",
    publicationYear: "2024",
    venue: "",
    doi: zenodoDoi,
    paste: "",
    tldr: "Algorithm description.",
  };
  applyRecordPageCard(state1, filename, card1, title, preprintPdf);
  assert.equal(state1.doi, "");

  // 2. 先頭ページに論文自身の DOI がある場合: 保存される
  const journalPdf = `
${title}
Alice Smith
DOI: ${realDoi}
Abstract
Algorithm description.
${"Background content for testing length. ".repeat(4)}
References
[1] Software library https://doi.org/${zenodoDoi}
`.trim();

  const state2 = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  state2.title = title;
  const card2 = {
    ...card1,
    doi: realDoi,
  };
  applyRecordPageCard(state2, filename, card2, title, journalPdf);
  assert.equal(state2.doi, realDoi);

  // 3. 先頭ページと参考文献の両方にある場合: 保存される
  const selfCitePdf = `
${title}
Alice Smith
DOI: ${realDoi}
Abstract
Algorithm description.
${"Background content for testing length. ".repeat(4)}
References
[1] Self citation https://doi.org/${realDoi}
`.trim();

  const state3 = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  state3.title = title;
  applyRecordPageCard(state3, filename, card2, title, selfCitePdf);
  assert.equal(state3.doi, realDoi);

  // 4. 参考文献の見出しがない PDF で先頭ページの DOI が保存される
  const noRefPdf = `
${title}
Alice Smith
DOI: ${realDoi}
Abstract
Algorithm description.
${"Background content for testing length. ".repeat(4)}
`.trim();

  const state4 = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  state4.title = title;
  applyRecordPageCard(state4, filename, card2, title, noRefPdf);
  assert.equal(state4.doi, realDoi);
});

test("issue 339: verifySciSpaceBibliography は PDF 後方の参考文献から DOI を誤抽出しない", async () => {
  const { verifySciSpaceBibliography } = await import("./scispace.ts");
  const filename = "arxiv_paper.pdf";
  const title = "New Transformer Model";
  const zenodoDoi = "10.5281/zenodo.9999999";
  // 3500 文字以降の参考文献にだけ他文献の DOI があるプレプリント
  const pdfText = `${title}\nAlice Smith\nAbstract\n${"Deep learning model analysis. ".repeat(120)}\nReferences\n[1] Tool https://doi.org/${zenodoDoi}\n`;

  const state = emptyState({ filename, inboxPdfPath: "", paperDir: "/tmp" });
  state.title = title;

  let lookupCalled = false;
  await verifySciSpaceBibliography(state, filename, pdfText, async () => {
    lookupCalled = true;
    return null;
  });

  // 参考文献にある DOI を lookup せず、state.doi も空のまま
  assert.equal(lookupCalled, false);
  assert.equal(state.doi, "");
});


