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
          if (typeof pattern === "object" && pattern.test("There are no results")) {
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
          if (typeof pattern === "object" && pattern.test("There are no results")) {
            return currentSearch !== "";
          }
          return false;
        },
        scrollIntoViewIfNeeded: async () => {},
      }),
    }),
    keyboard: {
      press: async () => {},
    },
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
