import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containsForeignPdf,
  doiFromHrefOrText,
  extractSciSpaceCardMeta,
  isolateSciSpaceCardText,
  normalizeFilesRowText,
  rawFilesCardPaste,
  needsRawFilesPaste,
  needsSciSpaceCardRecapture,
  filesRowHasTruncatedAuthors,
  isDummySciSpacePaste,
  isFilesAuthorMoreLabel,
  preferExpandedAuthorPaste,
  replaceYearAuthorLine,
  stripShowLess,
  stripTruncatedMore,
  eduShareSciSpaceMetadataPaste,
  pickBestSciSpaceCardText,
  sciSpaceExtractionLooksLikeChrome,
  titleLooksLikeFilename,
  titleLooksLikeBadSciSpaceCapture,
  venueLooksLikeBadSciSpaceCapture,
  looksLikeYearOnly,
  looksLikeUrlOrDomain,
  looksLikeSiteBoilerplate,
  isGenericJournalAlone,
  isTitlePrefixOf,
  looksLikeAuthorOrPaperId,
  looksLikeEditorField,
  looksLikePageRange,
  reconcileMetaFromFilesPaste,
  titleLooksLikeVenueOrConference,
  looksLikeCitationTitle,
  looksLikeSciSpaceNav,
  looksLikeUnansweredSciSpaceResponse,
  tldrUsable,
  descriptionUsable,
  descriptionLooksIncomplete,
  looksLikePdfApiSummary,
  sciSpaceDescriptionUsable,
  pickAbstractSection,
} from "./scispace-card.ts";

const noisy = [
  "Home",
  "Agent Gallery",
  "Templates",
  "2312.01865v1.pdf",
  "A comprehensive survey of Schwarzschild's original papers: Schwarzschild's trick and Einstein's s(h)tick",
  "2023\u22c5Galina Weinstein",
  "arXiv",
  "PDF UPLOAD",
  "Uploaded on 18 Sep 2026",
  "This paper examines Schwarzschild's contributions to general relativity, focusing on his methods for developing exact solutions. It highlights the collaborative exchange between Schwarzschild and Einstein, revealing that Einstein's preference for approximate solutions in 1916 was influenced by factors beyond singularity concerns 1.",
  "Column Settings",
].join("\n");

test("extractSciSpaceCardMeta: ナビ付きコピーからタイトル・年著者・arXiv・TL;DR を取る", () => {
  const m = extractSciSpaceCardMeta(noisy, "2312.01865v1.pdf");
  assert.match(m.title, /comprehensive survey of Schwarzschild/);
  assert.equal(m.publicationYear, "2023");
  assert.equal(m.authors, "Galina Weinstein");
  assert.equal(m.venue, "arXiv");
  assert.match(m.tldr, /This paper examines Schwarzschild's contributions/);
  assert.match(m.tldr, /beyond singularity concerns\.$/);
  assert.doesNotMatch(m.tldr, /\s\d+\.?$/);
  assert.equal(
    m.paste,
    [
      "A comprehensive survey of Schwarzschild's original papers: Schwarzschild's trick and Einstein's s(h)tick",
      "2023\u22c5Galina Weinstein",
      "arXiv",
    ].join("\n"),
  );
  assert.doesNotMatch(m.paste, /This paper examines/);
  assert.doesNotMatch(m.paste, /2312\.01865v1\.pdf/);
});

test("Files 行が1行でもタイトル・年著者・arXiv を貼り付け用に分ける", () => {
  const one =
    "2510.07777v1.pdf Drift No More? Context Equilibria in Multi-Turn LLM Interactions 2025 · Vardhan Dongre, Ryan A. Rossi arXiv PDF UPLOAD Uploaded on 20 Sep 2026 The paper investigates context drift in multi-turn interactions of Large Language Models (LLMs), proposing a framework to understand and mitigate this phenomenon.";
  const m = extractSciSpaceCardMeta(one, "2510.07777v1.pdf");
  assert.match(m.title, /Drift No More/);
  assert.equal(m.publicationYear, "2025");
  assert.match(m.authors, /Vardhan Dongre/);
  assert.equal(m.venue, "arXiv");
  assert.match(m.paste, /Drift No More/);
  assert.match(m.paste, /2025/);
  assert.match(normalizeFilesRowText(one), /\n2025/);
});

test("rawFilesCardPaste: Files 行をタイトル・著者だけに加工しない", () => {
  const row = [
    "2307.09009v3.pdf",
    "How is ChatGPT's behavior changing over time?",
    "2023 · Lingjiao Chen, Matei Zaharia, James Zou",
    "arXiv",
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
    "The paper investigates how the instruction-following capabilities of large language models (LLMs) like GPT-4 have changed over time, particularly in response to sensitive questions and composite instructions.",
  ].join("\n");
  const paste = rawFilesCardPaste(row, "2307.09009v3.pdf");
  assert.match(paste, /2307\.09009v3\.pdf/);
  assert.match(paste, /PDF UPLOAD/);
  assert.match(paste, /Uploaded on 20 Sep 2026/);
  assert.match(paste, /The paper investigates how the instruction-following/);
  assert.equal(paste, row);
  assert.notEqual(extractSciSpaceCardMeta(row, "2307.09009v3.pdf").paste, paste);
});

test("eduShareSciSpaceMetadataPaste: Dewdney のデモカードは空にする", () => {
  const dummy = [
    "nihms690699.pdf",
    "The First Law of Robotics Revisited: A New Perspective on Autonomous Systems",
    "2024⋅DOI⋅A. K. Dewdney",
    "null",
  ].join("\n");
  assert.equal(eduShareSciSpaceMetadataPaste(dummy, "nihms690699.pdf"), "");
});

test("eduShareSciSpaceMetadataPaste: タイトル・年⋅著者・掲載の3行から Show Less は取り除く", () => {
  const row = [
    "2510.07777v1.pdf",
    "Drift No More? Context Equilibria in Multi-Turn LLM Interactions",
    "2025\u22c5Vardhan Dongre, Ryan A. Rossi, Viet Dac Lai, David Seunghyun Yoon, Dilek Hakkani-T\u00fcr, Trung BuiShow Less",
    "arXiv",
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
    "The paper investigates context drift in multi-turn interactions of Large Language Models (LLMs), proposing a framework to understand and mitigate this phenomenon.",
  ].join("\n");
  const cleaned = [
    "Drift No More? Context Equilibria in Multi-Turn LLM Interactions",
    "2025\u22c5Vardhan Dongre, Ryan A. Rossi, Viet Dac Lai, David Seunghyun Yoon, Dilek Hakkani-T\u00fcr, Trung Bui",
    "arXiv",
  ].join("\n");
  assert.equal(eduShareSciSpaceMetadataPaste(row, "2510.07777v1.pdf"), cleaned);
  assert.doesNotMatch(eduShareSciSpaceMetadataPaste(row, "2510.07777v1.pdf"), /Show\s*Less/i);
  assert.doesNotMatch(eduShareSciSpaceMetadataPaste(row, "2510.07777v1.pdf"), /The paper investigates/);
});

test("eduShareSciSpaceMetadataPaste: ワークショップ掲載と +N More もメタ3行に残し TL;DR は入れない", () => {
  const meta = [
    "EVALUATING PERFORMANCE DRIFT FROM MODEL SWITCHING IN MULTI-TURN LLM SYSTEMS",
    "2026 · Raad Khraishi, Iman Zafar ...+2 More",
    "ICLR 2026 CAO Workshop",
  ].join("\n");
  const row = [
    "2603.03111v1.pdf",
    meta,
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
    "The paper introduces a switch-matrix benchmark to measure performance drift in multi-turn language model systems when switching between models. It highlights that even a single-turn handoff can significantly affect outcomes, emphasizing the need for monitoring and mitigation strategies to address operational reliability in these systems 1 2 .",
  ].join("\n");
  assert.equal(eduShareSciSpaceMetadataPaste(row, "2603.03111v1.pdf"), meta);
  const card = extractSciSpaceCardMeta(row, "2603.03111v1.pdf");
  assert.equal(card.venue, "ICLR 2026 CAO Workshop");
  assert.match(card.tldr, /switch-matrix benchmark/);
  assert.doesNotMatch(card.tldr, /\s1(\s+2)?\.?$/);
  assert.doesNotMatch(eduShareSciSpaceMetadataPaste(row, "2603.03111v1.pdf"), /switch-matrix/);
});

test("eduShareSciSpaceMetadataPaste: TL;DR とアップロード行だけなら空にする", () => {
  const row = [
    "42c1add0da9312ee.pdf",
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
    "The paper discusses the concept of multiverses, particularly focusing on the Level IV multiverse, which encompasses all possible mathematical structures.",
  ].join("\n");
  assert.equal(eduShareSciSpaceMetadataPaste(row, "42c1add0da9312ee.pdf"), "");
});

test("eduShareSciSpaceMetadataPaste: sciTitleRejected 時は題名行を貼り付け文面に含めない", () => {
  const paste = [
    "Hallucinated Wrong Title from SciSpace",
    "2023 · Author Name",
    "Journal of Example",
    "This is TL;DR text...",
  ].join("\n");
  const out = eduShareSciSpaceMetadataPaste(paste, "scanned_doc.pdf", {
    currentTitle: "scanned_doc",
    sciTitleRejected: true,
  });
  // 題名行は含まれず、年著者行と掲載誌行のみが出力される
  assert.doesNotMatch(out, /Hallucinated Wrong Title/);
  assert.match(out, /2023 · Author Name/);
  assert.match(out, /Journal of Example/);
});

test("reconcileMetaFromFilesPaste: sciTitleRejected が true のときは題名を戻さない", () => {
  const state = {
    title: "scanned_doc",
    venue: "",
    doi: "",
    filesPaste: [
      "Hallucinated Wrong Title",
      "2023 · Author Name",
      "Journal of Example",
    ].join("\n"),
    filename: "scanned_doc.pdf",
    sciTitleRejected: true,
  };
  const changed = reconcileMetaFromFilesPaste(state);
  // タイトルはファイル名のまま維持される
  assert.equal(state.title, "scanned_doc");
  // 掲載誌は補完される
  assert.equal(state.venue, "Journal of Example");
  assert.equal(changed, true);
});

test("extractSciSpaceCardMeta: 雑誌名が arXiv 以外でも掲載に残す", () => {
  const row = [
    "Eternal86.pdf",
    "ETERNALLY EXISTING SELF-REPRODUCING CHAOTIC INFLATIONARY UNIVERSE",
    "1986\u22c5A.D. Linde",
    "PHYSICS LETTERS B",
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
  ].join("\n");
  const card = extractSciSpaceCardMeta(row, "Eternal86.pdf");
  assert.equal(card.venue, "PHYSICS LETTERS B");
  assert.match(eduShareSciSpaceMetadataPaste(row, "Eternal86.pdf"), /PHYSICS LETTERS B/);
  const commun = [
    "1103899181.pdf",
    "Particle Creation by Black Holes",
    "1975\u22c5S. W. Hawking",
    "Commun. math. Phys.",
    "PDF UPLOAD",
    "Uploaded on 18 Sep 2026",
  ].join("\n");
  assert.equal(extractSciSpaceCardMeta(commun, "1103899181.pdf").venue, "Commun. math. Phys.");
  const everett = [
    "everett1957.pdf",
    '"Relative State" Formulation of Quantum Mechanics',
    "1957\u22c5Hugh Everett, III",
    "Reviews of Modern Physics",
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
  ].join("\n");
  assert.match(eduShareSciSpaceMetadataPaste(everett, "everett1957.pdf"), /Reviews of Modern Physics/);
});

test("needsSciSpaceCardRecapture: 省略著者だけでは取り直さず、年著者無しは取り直す", () => {
  assert.equal(
    needsSciSpaceCardRecapture({
      filename: "2601.15300v1.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/z",
      filesPaste:
        "2601.15300v1.pdf\nA title that is long enough\n2026⋅Weiwei Wang, Jiyong Min...+1 More\narXiv\nPDF UPLOAD\nUploaded on 20 Sep 2026",
    }),
    false,
  );
  assert.equal(
    needsSciSpaceCardRecapture({
      filename: "MerloNRC.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/m",
      title: "Nature Publishing Group",
      venue: "Pricing",
      filesPaste:
        "MerloNRC.pdf\nCancer as an evolutionary and ecological process\n2006⋅DOI⋅Lauren M.F. Merlo, John W. Pepper...+2 More\nNature Reviews Cancer\nPDF UPLOAD\nUploaded on 23 Sep 2026",
    }),
    true,
  );
  assert.equal(
    needsSciSpaceCardRecapture({
      filename: "2307.09009v3.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/x",
      filesPaste:
        "2307.09009v3.pdf\nThe First Law of Robotics Revisited: A New Perspective on Autonomous Systems\n2024⋅DOI⋅A. K. Dewdney\nnull\nPDF UPLOAD\nUploaded on 20 Sep 2026",
    }),
    true,
  );
  assert.equal(
    needsSciSpaceCardRecapture({
      filename: "nihms690699.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/n",
      filesPaste:
        "nihms690699.pdf\nThe First Law of Robotics Revisited: A New Perspective on Autonomous Systems\n2024⋅DOI⋅A. K. Dewdney\nnull\nPDF UPLOAD\nUploaded on 21 Sep 2026",
    }),
    true,
  );
  assert.equal(
    needsSciSpaceCardRecapture({
      filename: "0709.2257v2.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/g",
      filesPaste: "Uber das Gravitationsfeld eines Massenpunktes\narXiv:0709.2257v2 [gr-qc] 29 Sep 2007",
    }),
    true,
  );
  assert.equal(
    needsSciSpaceCardRecapture({
      filename: "Eternal86.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/e",
      filesPaste:
        "Eternal86.pdf\nETERNALLY EXISTING SELF-REPRODUCING CHAOTIC INFLATIONARY UNIVERSE\n1986⋅A.D. Linde\nPHYSICS LETTERS B\nPDF UPLOAD\nUploaded on 20 Sep 2026",
    }),
    false,
  );
});

test("needsRawFilesPaste: タイトル・著者だけの貼り付けは取り直す", () => {
  assert.equal(
    needsRawFilesPaste({
      filename: "2307.09009v3.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/x",
      filesPaste: "The First Law of Robotics Revisited: A New Perspective on Autonomous Systems\n2024⋅DOI⋅A. K. Dewdney",
    }),
    true,
  );
  assert.equal(
    needsRawFilesPaste({
      filename: "2307.03172v3.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/y",
      filesPaste: "",
    }),
    true,
  );
  assert.equal(
    needsRawFilesPaste({
      filename: "2601.15300v1.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/z",
      filesPaste:
        "2601.15300v1.pdf\nA title\n2026⋅Weiwei Wang\narXiv\nPDF UPLOAD\nUploaded on 20 Sep 2026",
    }),
    false,
  );
  assert.equal(
    needsRawFilesPaste({
      filename: "2510.07777v1.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/more",
      filesPaste:
        "2510.07777v1.pdf\nDrift No More? Context Equilibria in Multi-Turn LLM Interactions\n2025 · Vardhan Dongre, Ryan A. Rossi ...+4 More\narXiv\nPDF UPLOAD\nUploaded on 20 Sep 2026",
    }),
    false,
  );
});

test("filesRowHasTruncatedAuthors: +N More と展開後", () => {
  assert.equal(
    filesRowHasTruncatedAuthors("2025 · Vardhan Dongre, Ryan A. Rossi ...+4 More"),
    true,
  );
  assert.equal(
    filesRowHasTruncatedAuthors("2026⋅Jingxuan Chen, Mohammad Taher Pilehvar...+1 More"),
    true,
  );
  assert.equal(
    filesRowHasTruncatedAuthors(
      "2025 · Vardhan Dongre, Ryan A. Rossi, Viet Dac Lai, David Seunghyun Yoon, Dilek Hakkani-Tür, Trung Bui Show Less",
    ),
    false,
  );
  assert.equal(
    filesRowHasTruncatedAuthors(
      "2026⋅Jingxuan Chen, Mohammad Taher Pilehvar...+1 More\n2026⋅Jingxuan Chen, Mohammad Taher Pilehvar, Third Author Show Less",
    ),
    false,
  );
  assert.equal(isFilesAuthorMoreLabel("+1 More"), true);
  assert.equal(isFilesAuthorMoreLabel("...+4 More"), true);
  assert.equal(isFilesAuthorMoreLabel("2026⋅Jingxuan Chen...+1 More"), false);
  const mixed = [
    "2603.22608v2.pdf",
    "Understanding LLM Performance Degradation",
    "2026⋅Jingxuan Chen, Mohammad Taher Pilehvar...+1 More",
    "2026⋅Jingxuan Chen, Mohammad Taher Pilehvar, Third Author Show Less",
    "arXiv",
  ].join("\n");
  const preferred = preferExpandedAuthorPaste(mixed);
  assert.match(preferred, /Third Author/);
  assert.doesNotMatch(preferred, /Show\s*Less/i);
  assert.doesNotMatch(preferred, /\+1 More/);
  const filled = replaceYearAuthorLine(
    "2603.22608v2.pdf\nUnderstanding LLM Performance Degradation\n2026⋅Jingxuan Chen, Mohammad Taher Pilehvar...+1 More\narXiv",
    "2026⋅Jingxuan Chen, Mohammad Taher Pilehvar, Third Author",
  );
  assert.match(filled, /Third Author/);
  assert.doesNotMatch(filled, /\+1 More/);
  assert.equal(filesRowHasTruncatedAuthors(filled), false);
});

test("Files カードは TL;DR のあと隣のタイトルを混ぜない", () => {
  const mixed = [
    "2307.09009v3.pdf",
    "How is ChatGPT's behavior changing over time?",
    "2023 · Lingjiao Chen, Matei Zaharia, James Zou",
    "arXiv",
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
    "The paper investigates how the instruction-following capabilities of large language models (LLMs) like GPT-4 have changed over time, particularly in response to sensitive questions and composite instructions.",
    "The First Law of Robotics Revisited: A New Perspective on Autonomous Systems",
    "2024⋅DOI⋅A. K. Dewdney",
  ].join("\n");
  const m = extractSciSpaceCardMeta(mixed, "2307.09009v3.pdf");
  assert.match(m.title, /ChatGPT/);
  assert.doesNotMatch(m.title, /First Law of Robotics/);
  assert.match(m.authors, /Lingjiao Chen/);
  assert.doesNotMatch(m.paste, /Dewdney/);
});

test("rawFilesCardPaste: Dewdney のデモカードは捨てる", () => {
  const dummy = [
    "nihms690699.pdf",
    "The First Law of Robotics Revisited: A New Perspective on Autonomous Systems",
    "2024⋅DOI⋅A. K. Dewdney",
    "null",
    "PDF UPLOAD",
    "Uploaded on 21 Sep 2026",
  ].join("\n");
  assert.equal(rawFilesCardPaste(dummy, "nihms690699.pdf"), "");
  assert.equal(isDummySciSpacePaste(dummy), true);
  assert.equal(
    isDummySciSpacePaste("How is ChatGPT's behavior changing over time?\n2023 · Lingjiao Chen"),
    false,
  );
});

test("Files 行が1行でもタイトル・年著者・arXiv を貼り付け用に分ける", () => {
  const one =
    "2510.07777v1.pdf Drift No More? Context Equilibria in Multi-Turn LLM Interactions 2025 · Vardhan Dongre, Ryan A. Rossi arXiv PDF UPLOAD Uploaded on 20 Sep 2026 The paper investigates context drift in multi-turn interactions of Large Language Models (LLMs), proposing a framework to understand and mitigate this phenomenon.";
  const m = extractSciSpaceCardMeta(one, "2510.07777v1.pdf");
  assert.match(m.title, /Drift No More/);
  assert.equal(m.publicationYear, "2025");
  assert.match(m.authors, /Vardhan Dongre/);
  assert.equal(m.venue, "arXiv");
  assert.match(m.paste, /Drift No More/);
  assert.match(m.paste, /2025/);
  assert.match(normalizeFilesRowText(one), /\n2025/);
});

test("rawFilesCardPaste: Files 行をタイトル・著者だけに加工しない", () => {
  const row = [
    "2307.09009v3.pdf",
    "How is ChatGPT's behavior changing over time?",
    "2023 · Lingjiao Chen, Matei Zaharia, James Zou",
    "arXiv",
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
    "The paper investigates how the instruction-following capabilities of large language models (LLMs) like GPT-4 have changed over time, particularly in response to sensitive questions and composite instructions.",
  ].join("\n");
  const paste = rawFilesCardPaste(row, "2307.09009v3.pdf");
  assert.match(paste, /2307\.09009v3\.pdf/);
  assert.match(paste, /PDF UPLOAD/);
  assert.match(paste, /Uploaded on 20 Sep 2026/);
  assert.match(paste, /The paper investigates how the instruction-following/);
  assert.equal(paste, row);
  assert.notEqual(extractSciSpaceCardMeta(row, "2307.09009v3.pdf").paste, paste);
});

test("needsRawFilesPaste: タイトル・著者だけの貼り付けは取り直す", () => {
  assert.equal(
    needsRawFilesPaste({
      filename: "2307.09009v3.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/x",
      filesPaste: "The First Law of Robotics Revisited: A New Perspective on Autonomous Systems\n2024⋅DOI⋅A. K. Dewdney",
    }),
    true,
  );
  assert.equal(
    needsRawFilesPaste({
      filename: "2307.03172v3.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/y",
      filesPaste: "",
    }),
    true,
  );
  assert.equal(
    needsRawFilesPaste({
      filename: "2601.15300v1.pdf",
      eduShareTestUrl: "http://localhost:3000/tests/z",
      filesPaste:
        "2601.15300v1.pdf\nA title\n2026⋅Weiwei Wang\narXiv\nPDF UPLOAD\nUploaded on 20 Sep 2026",
    }),
    false,
  );
});

test("Files カードは TL;DR のあと隣のタイトルを混ぜない", () => {
  const mixed = [
    "2307.09009v3.pdf",
    "How is ChatGPT's behavior changing over time?",
    "2023 · Lingjiao Chen, Matei Zaharia, James Zou",
    "arXiv",
    "PDF UPLOAD",
    "Uploaded on 20 Sep 2026",
    "The paper investigates how the instruction-following capabilities of large language models (LLMs) like GPT-4 have changed over time, particularly in response to sensitive questions and composite instructions.",
    "The First Law of Robotics Revisited: A New Perspective on Autonomous Systems",
    "2024⋅DOI⋅A. K. Dewdney",
  ].join("\n");
  const m = extractSciSpaceCardMeta(mixed, "2307.09009v3.pdf");
  assert.match(m.title, /ChatGPT/);
  assert.doesNotMatch(m.title, /First Law of Robotics/);
  assert.match(m.authors, /Lingjiao Chen/);
  assert.doesNotMatch(m.paste, /Dewdney/);
});

const mixedFiles = [
  "Home",
  "Files (5)",
  "1103899181.pdf",
  "PDF UPLOAD",
  "Uploaded on 18 Sep 2026",
  "The paper discusses how quantum mechanical effects allow black holes to emit particles, leading to a gradual decrease in their mass and eventual evaporation.",
  "2312.01865v1.pdf",
  "A comprehensive survey of Schwarzschild's original papers: Schwarzschild's trick and Einstein's s(h)tick",
  "2023\u22c5Galina Weinstein",
  "arXiv",
  "This paper examines Schwarzschild's contributions to general relativity, focusing on his methods for developing exact solutions.",
  "hawking.pdf",
  "BLACK HOLES AREN'T BLACK",
  "1974\u22c5S. W. Hawking",
].join("\n");

test("isolateSciSpaceCardText: 次の PDF 行で切って隣のカードを混ぜない", () => {
  const card = isolateSciSpaceCardText(mixedFiles, "1103899181.pdf");
  assert.match(card, /1103899181\.pdf/);
  assert.doesNotMatch(card, /2312\.01865v1/);
  assert.doesNotMatch(card, /Schwarzschild/);
  assert.doesNotMatch(card, /hawking\.pdf/);
});

test("extractSciSpaceCardMeta: 一覧の隣カードのタイトルを自分の論文にしない", () => {
  const m = extractSciSpaceCardMeta(mixedFiles, "1103899181.pdf");
  assert.doesNotMatch(m.title, /Schwarzschild/);
  assert.equal(m.authors, "");
  assert.equal(m.publicationYear, "");
  assert.equal(m.venue, "");
  assert.match(m.tldr, /quantum mechanical effects/);
  assert.equal(containsForeignPdf(mixedFiles, "1103899181.pdf"), true);
});

test("extractSciSpaceCardMeta: 混在コピーでも指定ファイルのカードは取れる", () => {
  const m = extractSciSpaceCardMeta(mixedFiles, "2312.01865v1.pdf");
  assert.match(m.title, /comprehensive survey of Schwarzschild/);
  assert.equal(m.authors, "Galina Weinstein");
  assert.doesNotMatch(m.title, /BLACK HOLES/);
});

const lineweaverCard = [
  "LineweaverPatel2023final.pdf",
  "All objects and some questions",
  "2023\u22c5DOI\u22c5Charles H. Lineweaver, Vihan M. Patel",
  "American Journal of Physics",
  "PDF UPLOAD",
  "Uploaded on 19 Sep 2026",
  "The paper explores the thermal history of the Universe, detailing how various objects formed as it expanded and cooled. It discusses the relationship between gravity and quantum mechanics, particularly in the context of Planck-mass black holes and the concept of the Universe potentially being a black hole itself.",
].join("\n");

test("extractSciSpaceCardMeta: Files 右列の TL;DR と年·DOI·著者を取る", () => {
  const m = extractSciSpaceCardMeta(lineweaverCard, "LineweaverPatel2023final.pdf");
  assert.equal(m.title, "All objects and some questions");
  assert.equal(m.publicationYear, "2023");
  assert.equal(m.authors, "Charles H. Lineweaver, Vihan M. Patel");
  assert.equal(m.venue, "American Journal of Physics");
  assert.match(m.tldr, /thermal history of the Universe/);
  assert.equal(m.doi, "");
});

test("Files 左列の PDF UPLOAD 行は TL;DR ではない", () => {
  const left = "All objects and some questions 2023⋅DOI⋅Charles H. Lineweaver, Vihan M. Patel American Journal of Physics PDF UPLOAD Uploaded on 19 Sep.";
  assert.equal(looksLikeSciSpaceNav(left), true);
  assert.equal(descriptionUsable(left), false);
  assert.equal(tldrUsable(left), false);
});

test("Files 一覧の TL;DR 列（The paper / This paper）を取る", () => {
  const popper = [
    "Popper-Conjectures-Rwefutations-GrowthOfKnowledge.pdf",
    "CONJECTURES AND REFUTATIONS The Growth of Scientific Knowledge",
    "1962 · Karl R. Popper",
    "PDF UPLOAD",
    "Uploaded on 19 Sep 2026",
    "The paper discusses the importance of learning from mistakes in the pursuit of knowledge, emphasizing that criticism and tentative solutions are essential for scientific progress. It argues that while knowledge can never be positively justified, it can grow through the process of identifying and correcting errors 1.",
  ].join("\n");
  const p = extractSciSpaceCardMeta(popper, "Popper-Conjectures-Rwefutations-GrowthOfKnowledge.pdf");
  assert.match(p.tldr, /learning from mistakes/);
  assert.doesNotMatch(p.tldr, /\s1\.?$/);

  const schwarz = [
    "0709.2257v2.pdf",
    "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    "2007 · Lluís Bel",
    "arXiv",
    "This paper discusses the complexities of Schwarzschild's solution to Einstein's field equations, emphasizing its pedagogical purpose and the need for clarity in understanding the gravitational field of a point particle. It aims to present a simpler and more aesthetically pleasing form of the solution while remaining true to Schwarzschild's original intent 1 2.",
  ].join("\n");
  const s = extractSciSpaceCardMeta(schwarz, "0709.2257v2.pdf");
  assert.match(s.tldr, /complexities of Schwarzschild/);
  assert.doesNotMatch(s.tldr, /\s1\s+2\.?$/);
});

test("doiFromHrefOrText: doi.org リンクから DOI を取る", () => {
  assert.equal(doiFromHrefOrText("https://doi.org/10.1119/5.0150209"), "10.1119/5.0150209");
  assert.equal(doiFromHrefOrText("2023 · DOI · Charles H. Lineweaver"), "");
});

test("isolateSciSpaceCardText: 検索欄の stem だけでは隣カードを自分の論文にしない", () => {
  const searchThenNeighbor = [
    "819_1_5.0150209",
    "All objects and some questions",
    "2023\u22c5DOI\u22c5Charles H. Lineweaver, Vihan M. Patel",
    "LineweaverPatel2023final.pdf",
    "All objects and some questions",
  ].join("\n");
  const isolated = isolateSciSpaceCardText(searchThenNeighbor, "819_1_5.0150209.pdf");
  assert.equal(isolated, "");
});

test("rawFilesCardPaste: 画面で空白が潰れた長いファイル名も同じカードにする", () => {
  const filename =
    "Geophysical Research Letters - 2022 - Cressie - From Many to One  Consensus Inference in a MIP.pdf";
  const shown = [
    "Geophysical Research Letters - 2022 - Cressie - From Many to One Consensus Inference in a MIP.pdf",
    "From Many to One: Consensus Inference in a MIP",
    "2022 · DOI · Noel Cressie",
    "Geophysical Research Letters",
    "The paper discusses the importance of consensus estimation.",
  ].join("\n");
  const paste = rawFilesCardPaste(shown, filename);
  assert.match(paste, /Noel Cressie/);
  assert.match(paste, /consensus estimation/);
});

test("pickBestSciSpaceCardText: ファイル名だけのセルより TL;DR 付きカードを選ぶ", () => {
  const filenameOnly = "LineweaverPatel2023final.pdf";
  const picked = pickBestSciSpaceCardText(
    [filenameOnly, lineweaverCard],
    "LineweaverPatel2023final.pdf",
  );
  const m = extractSciSpaceCardMeta(picked, "LineweaverPatel2023final.pdf");
  assert.match(m.tldr, /thermal history of the Universe/);
  assert.equal(m.title, "All objects and some questions");
});

test("SciSpace 個別ページの Explain math はタイトルにしない", () => {
  const chrome = [
    "Explain math & table",
    "Generate summary of this paper, Results of the paper, Conclusions from the paper",
    "0709.2257v2.pdf",
  ].join("\n");
  const m = extractSciSpaceCardMeta(chrome, "0709.2257v2.pdf");
  assert.notEqual(m.title, "Explain math & table");
  assert.equal(m.tldr.includes("Generate summary of this paper"), false);
});

test("個別ページの og:description 相当は TL;DR にできる", () => {
  const raw = [
    "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    "This paper derives the gravitational field of a mass point according to Einstein's theory and discusses the resulting metric.",
  ].join("\n");
  const m = extractSciSpaceCardMeta(raw, "0709.2257v2.pdf");
  assert.match(m.title, /Gravitationsfeld/);
  assert.match(m.tldr, /gravitational field of a mass point/);
});

test("arXiv:ID 行は論文タイトル扱いしない", () => {
  assert.equal(
    titleLooksLikeFilename("arXiv:0709.2257v2 [gr-qc] 29 Sep 2007", "0709.2257v2.pdf"),
    true,
  );
  const m = extractSciSpaceCardMeta(
    "arXiv:0709.2257v2 [gr-qc] 29 Sep 2007\nÜber das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    "0709.2257v2.pdf",
  );
  assert.match(m.title, /Gravitationsfeld/);
});

test("空の TL;DR は画面の文言ではない", () => {
  assert.equal(sciSpaceExtractionLooksLikeChrome("Explain math & table", ""), true);
  assert.equal(
    sciSpaceExtractionLooksLikeChrome(
      "Particle Creation by Black Holes",
      "",
    ),
    false,
  );
  assert.equal(
    sciSpaceExtractionLooksLikeChrome(
      "Particle Creation by Black Holes",
      "Generate summary of this paper, Results of the paper",
    ),
    true,
  );
});

test("引用行や unit volume 断片はタイトル・掲載にしない", () => {
  const raw = [
    "Commun. math. Phys. 43, 199—220 (1975)",
    "Particle Creation by Black Holes",
    "modes per unit volume in the frequency interval",
    "inside the black hole where the Killing vector which represents time translations and has a much longer body fragment without being an abstract",
  ].join("\n");
  const m = extractSciSpaceCardMeta(raw, "1103899181.pdf");
  assert.equal(m.title, "Particle Creation by Black Holes");
  assert.notEqual(m.venue, "modes per unit volume in the frequency interval");
  assert.equal(m.tldr.startsWith("inside the black hole"), false);
});

test("誌名だけの行は論文タイトルにしない", () => {
  const raw = [
    "Publications of the Astronomical Society of Australia",
    "Galaxy spin direction asymmetry in JWST deep fields",
  ].join("\n");
  const m = extractSciSpaceCardMeta(raw, "2403.17271v1.pdf");
  assert.match(m.title, /Galaxy spin direction/);
});

test("titleLooksLikeBadSciSpaceCapture: ISSN や vol. 断片を弾く", () => {
  assert.equal(titleLooksLikeBadSciSpaceCapture("ISSN 1473-0197"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("Paper-like electronic displays: Large-area rubber-"), true);
  assert.equal(
    titleLooksLikeBadSciSpaceCapture(
      "Virtual electrowetting channels: electronic liquid transport with continuous channel functionality†",
    ),
    false,
  );
  assert.equal(titleLooksLikeBadSciSpaceCapture("Nature Publishing Group"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("Content maybe subject to copyright Report"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("085001_1_5.0323853.pdf"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("vol. 98"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("This journal is"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("Pricing"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("Lab on a Chip"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("Nature Reviews Cancer"), false);
});

test("reconcileMetaFromFilesPaste: Files 行の正しいメタで state を戻す", () => {
  const filesPaste =
    "Lab-on-a-Chip.pdf\nVirtual electrowetting channels: electronic liquid transport with continuous channel functionality†\n2010⋅DOI⋅Manjeet Dhindsa, Jason Heikenfeld...+4 More\nLab on a Chip";
  const state = {
    filename: "Lab-on-a-Chip.pdf",
    title: "ISSN 1473-0197",
    venue: "This journal is",
    doi: "10.1039/b925278a",
    filesPaste,
  };
  assert.equal(reconcileMetaFromFilesPaste(state), true);
  assert.match(state.title, /Virtual electrowetting channels/);
  assert.equal(state.venue, "Lab on a Chip");
});

test("日付・ページ範囲・PDF全画面はタイトルにしない", () => {
  assert.equal(looksLikeCitationTitle("OCTOBER 01 2023"), true);
  assert.equal(looksLikeCitationTitle(", 1–20 (2025)"), true);
  assert.equal(looksLikeCitationTitle(", 9681-9702; doi:10.3390/s150509681"), true);
  assert.equal(looksLikeCitationTitle("Read PDF in full screen"), true);
  assert.equal(looksLikeCitationTitle("© by Springer-Verlag 1975"), true);
  assert.equal(looksLikeCitationTitle("All objects and some questions"), false);
});

test("途中切れの TL;DR は使わない", () => {
  assert.equal(
    tldrUsable("This paper highlights the interplay between Karl Schwarzschild’s mathematical inge-"),
    false,
  );
  assert.equal(
    tldrUsable("We present an overview of the thermal history of the Universe and the sequence of objects (e.g.,."),
    false,
  );
  assert.equal(
    tldrUsable(
      "Schwarzschild's solution of Einstein's field equations in vacuum can be written in many different forms. Unfortunately Schwarzschild's own original form is less nice looking.",
    ),
    true,
  );
});

test("Abstract 見出しの段落を TL;DR にする", () => {
  const raw = [
    "Abstract",
    "Schwarzschild's solution of Einstein's field equations in vacuum can be written in many different forms. We prove here that we can have both a nice looking simple form and the meaning that Schwarzschild wanted.",
    "1. Introduction",
  ].join("\n");
  assert.match(pickAbstractSection(raw), /Schwarzschild's solution of Einstein's field equations/);
});

test("looksLikePdfApiSummary: PDF 要約 API 形式を SciSpace より下げる", () => {
  assert.equal(
    looksLikePdfApiSummary("以下に資料本文の要約を記載します。\n\n### 主な研究手法\n…"),
    true,
  );
  assert.equal(
    looksLikePdfApiSummary("The paper discusses quantum effects on black holes."),
    false,
  );
  assert.equal(
    sciSpaceDescriptionUsable(
      "The paper discusses quantum effects on black holes and explains how particle creation occurs near the event horizon under specific conditions.",
    ),
    true,
  );
});

test("descriptionLooksIncomplete: 途中切れの PDF 要約を弾く", () => {
  assert.equal(
    descriptionLooksIncomplete(
      "### 主な研究手法\nLuo and Hou [10]によって提案された3D Euler方程式の有限時間ブローアップシナリオを解明するため、2次元モデル「双曲型Boussinesqシステム」を",
    ),
    true,
  );
  assert.equal(
    descriptionLooksIncomplete(
      "以下に資料本文の要約を記載します。\n\n### 主な研究手法\n通常のテンソル計算規則が用いられた。",
    ),
    true,
  );
  assert.equal(
    descriptionLooksIncomplete(
      "### 主な研究手法\n本研究では、IoT技術に基づく道路・橋梁インテリジェント監視システムを設計しました。",
    ),
    false,
  );
});

test("長い日本語要約は画面文言ではなく説明に使える", () => {
  const s = [
    "この資料は、カール・R・ポパーによる著書『推測と反駁：科学的知識の成長』の序文と導入部分からの抜粋です。",
    "",
    "### 主な研究手法",
    "推測と反駁を通じて科学的知識が成長するという立場を、具体例を交えて整理している。",
  ].join("\n");
  assert.equal(looksLikeSciSpaceNav(s), false);
  assert.equal(descriptionUsable(s), true);
});

test("SciSpace のプロンプト列は長くても説明にしない", () => {
  const s =
    "Generate summary of this paper, Results of the paper, Conclusions from the paper, Explain Abstract of this paper, What are the contributions of this paper, Find Related Papers, Explain the practical implications of this paper, Summarise introduction of this paper, Literature survey of this paper, Methods used in this paper, What data has been used in this paper, Limitations of this paper, Future works suggested in this paper.";
  assert.equal(looksLikeSciSpaceNav(s), true);
  assert.equal(descriptionUsable(s), false);
  assert.equal(tldrUsable(s), false);
});

test("looksLikeSciSpaceNav: ページ先頭の Skip to Main Content は題名にしない", () => {
  assert.equal(looksLikeSciSpaceNav("Skip to Main Content"), true);
  assert.equal(looksLikeSciSpaceNav("Skip to content"), true);
  assert.equal(looksLikeSciSpaceNav("Planck stars"), false);
});

test("looksLikeUnansweredSciSpaceResponse: 論文から答えが取れなかった返事を判定する", () => {
  assert.equal(looksLikeUnansweredSciSpaceResponse("Not addressed in the paper."), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("Not addressed in the paper"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("Not mentioned"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("not specified"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("Not stated in the paper"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("Not provided"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("Not found in the paper."), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("No information provided"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("The paper does not mention the authors"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("N/A"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("None"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("該当なし"), true);
  assert.equal(looksLikeUnansweredSciSpaceResponse("論文内には記載がありません"), true);

  // 通常の論文タイトルや要約は false
  assert.equal(looksLikeUnansweredSciSpaceResponse("Attention Is All You Need"), false);
  assert.equal(looksLikeUnansweredSciSpaceResponse("Deep Residual Learning for Image Recognition"), false);
  assert.equal(
    looksLikeUnansweredSciSpaceResponse(
      "This paper proposes a novel framework for deep residual networks that achieves state of the art results.",
    ),
    false,
  );
});

test("titleLooksLikeBadSciSpaceCapture: Not addressed in the paper. を弾く", () => {
  assert.equal(titleLooksLikeBadSciSpaceCapture("Not addressed in the paper."), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("Not mentioned"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("not specified"), true);
});

test("extractSciSpaceCardMeta: Not addressed などの未回答文言はタイトル・著者・要約に採用しない", () => {
  const paste = [
    "test.pdf",
    "Not addressed in the paper.",
    "2023 · Not specified",
    "Uploaded on 18 Sep 2026",
    "Not mentioned in the paper.",
  ].join("\n");
  const meta = extractSciSpaceCardMeta(paste, "test.pdf");
  assert.equal(meta.title, "");
  assert.equal(meta.authors, "");
  assert.equal(meta.tldr, "");
});


test("rawFilesCardPaste: 語中改行の名前をまとめ、隣の PDF のメタは含めない", () => {
  const raw = [
    "phase2_3_", "0_1.pdf", "Quantum Error Correction", "2024 · Alice Smith",
    "The paper presents a detailed analysis of error correction across several computing platforms.",
    "other.pdf", "Unrelated Paper", "2025 · Bob Jones",
  ].join("\n");
  const paste = rawFilesCardPaste(raw, "phase2_3_0_1.pdf");
  assert.match(paste, /Alice Smith/);
  assert.doesNotMatch(paste, /Bob Jones|Unrelated Paper/);
});

test("issue #130: venueLooksLikeBadSciSpaceCapture は年だけ・URL/ドメイン・著者名・サイト文言・Journal単体を弾く", () => {
  // 年だけ
  assert.equal(venueLooksLikeBadSciSpaceCapture("2023"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("(2023)"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("2020"), true);
  assert.equal(looksLikeYearOnly("2023"), true);
  assert.equal(looksLikeYearOnly("2021-2022"), true);

  // 記事URL・ドメイン
  assert.equal(venueLooksLikeBadSciSpaceCapture("journal.ntt.co.jp"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("http://www.mdpi.com/journal/sensors"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("https://www.nature.com/articles/xyz"), true);
  assert.equal(looksLikeUrlOrDomain("journal.ntt.co.jp"), true);
  assert.equal(looksLikeUrlOrDomain("http://www.mdpi.com/journal/sensors"), true);

  // 著者名・原稿/論文ID
  assert.equal(venueLooksLikeBadSciSpaceCapture("35_18C5-01"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("kan17yamagiwa"), true);
  assert.equal(looksLikeAuthorOrPaperId("35_18C5-01"), true);
  assert.equal(looksLikeAuthorOrPaperId("kan17yamagiwa"), true);

  // サイト文言
  assert.equal(venueLooksLikeBadSciSpaceCapture("Open access to the Proceedings of the"), true);
  assert.equal(looksLikeSiteBoilerplate("Open access to the Proceedings of the"), true);

  // 汎用語 Journal / journal 単体
  assert.equal(venueLooksLikeBadSciSpaceCapture("Journal"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("journal"), true);
  assert.equal(venueLooksLikeBadSciSpaceCapture("The Journal"), true);
  assert.equal(isGenericJournalAlone("Journal"), true);
  assert.equal(isGenericJournalAlone("journal"), true);

  // 正常な掲載誌や空白のない略誌名は false
  assert.equal(venueLooksLikeBadSciSpaceCapture("Nature"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("Bone"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("Lab on a Chip"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("PHYSICS LETTERS B"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("Journal of Example"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("Proceedings of the National Academy of Sciences"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("American Journal of Physics"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("eLife"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("npj Quantum Information"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("Phys.Rev.Lett"), false);
  assert.equal(venueLooksLikeBadSciSpaceCapture("Nucl.Phys.B"), false);
  assert.equal(looksLikeUrlOrDomain("Phys.Rev.Lett"), false);
  assert.equal(looksLikeUrlOrDomain("Nucl.Phys.B"), false);
});

test("issue #130: 掲載誌抽出で年だけ・URL/ドメイン・著者名・サイト文言・Journal単体を採用せず空にする", () => {
  // 1. 年だけ (2023)
  const cardYearOnly = [
    "example-paper.pdf",
    "Sample Research Paper Title",
    "2023",
    "This paper investigates quantum algorithms for molecular simulation and presents benchmark results.",
  ].join("\n");
  const metaYearOnly = extractSciSpaceCardMeta(cardYearOnly, "example-paper.pdf");
  assert.equal(metaYearOnly.venue, "");
  assert.doesNotMatch(metaYearOnly.paste, /\n2023$/);
  assert.equal(eduShareSciSpaceMetadataPaste(cardYearOnly, "example-paper.pdf"), "Sample Research Paper Title");

  // 2. 記事URL (sensors-15-09681: http://www.mdpi.com/journal/sensors)
  const cardUrl = [
    "sensors-15-09681.pdf",
    "A Low-Cost Multi-Sensor Wireless Body Area Network for Healthcare Applications",
    "2015 · John Doe, Jane Smith",
    "http://www.mdpi.com/journal/sensors",
    "This paper presents the design and evaluation of a low-cost wireless sensor network for remote health monitoring.",
  ].join("\n");
  const metaUrl = extractSciSpaceCardMeta(cardUrl, "sensors-15-09681.pdf");
  assert.equal(metaUrl.venue, "");
  assert.doesNotMatch(metaUrl.paste, /mdpi\.com/);

  // 3. ドメイン (nttjnl5003_20231201: journal.ntt.co.jp)
  const cardDomain = [
    "nttjnl5003_20231201.pdf",
    "Advances in Next-Generation Optical Fiber Technologies",
    "2023 · Taro Yamada, Hanako Suzuki",
    "journal.ntt.co.jp",
    "This paper introduces recent breakthroughs in high-capacity optical fiber transmission systems and future prospects.",
  ].join("\n");
  const metaDomain = extractSciSpaceCardMeta(cardDomain, "nttjnl5003_20231201.pdf");
  assert.equal(metaDomain.venue, "");
  assert.doesNotMatch(metaDomain.paste, /ntt\.co\.jp/);

  // 4. 著者名/ID (35_18C5-01)
  const cardId1 = [
    "35_18C5-01.pdf",
    "A Study on Parallel Processing Efficiency in Distributed Computing",
    "35_18C5-01",
    "This paper discusses performance optimization techniques in modern distributed cluster architectures.",
  ].join("\n");
  const metaId1 = extractSciSpaceCardMeta(cardId1, "35_18C5-01.pdf");
  assert.equal(metaId1.venue, "");
  assert.doesNotMatch(metaId1.paste, /35_18C5-01$/);

  // 5. 著者名/citekey (kan17yamagiwa)
  const cardId2 = [
    "kan17yamagiwa.pdf",
    "Acceleration of Sparse Matrix Computations on Stream Architectures",
    "kan17yamagiwa",
    "This paper explores stream processing optimizations for sparse linear algebra workloads.",
  ].join("\n");
  const metaId2 = extractSciSpaceCardMeta(cardId2, "kan17yamagiwa.pdf");
  assert.equal(metaId2.venue, "");
  assert.doesNotMatch(metaId2.paste, /kan17yamagiwa$/);

  // 6. サイト文言 (sec18-zhang_0: Open access to the Proceedings of the)
  const cardBoilerplate = [
    "sec18-zhang_0.pdf",
    "Towards Automated Security Analysis of Smart Contracts",
    "2018 · Alice Zhang, Bob Lee",
    "Open access to the Proceedings of the",
    "This paper addresses vulnerability detection in decentralized smart contract execution environments.",
  ].join("\n");
  const metaBoilerplate = extractSciSpaceCardMeta(cardBoilerplate, "sec18-zhang_0.pdf");
  assert.equal(metaBoilerplate.venue, "");
  assert.doesNotMatch(metaBoilerplate.paste, /Open access/);

  // 7. 汎用語 Journal / journal 単体
  const cardJournalUpper = [
    "paper-with-journal.pdf",
    "Theoretical Foundation of Neural Network Regularization",
    "2022 · Author One",
    "Journal",
    "This paper analyzes the mathematical foundations of regularization dynamics in overparameterized models.",
  ].join("\n");
  const metaJournalUpper = extractSciSpaceCardMeta(cardJournalUpper, "paper-with-journal.pdf");
  assert.equal(metaJournalUpper.venue, "");
  assert.doesNotMatch(metaJournalUpper.paste, /\nJournal$/);

  const cardJournalLower = [
    "paper-with-journal-lower.pdf",
    "Theoretical Foundation of Neural Network Regularization",
    "2022 · Author One",
    "journal",
    "This paper analyzes the mathematical foundations of regularization dynamics in overparameterized models.",
  ].join("\n");
  const metaJournalLower = extractSciSpaceCardMeta(cardJournalLower, "paper-with-journal-lower.pdf");
  assert.equal(metaJournalLower.venue, "");
  assert.doesNotMatch(metaJournalLower.paste, /\njournal$/);

  // 8. 小文字で始まる正規の掲載誌名 (eLife, npj Quantum Information) を維持する
  const cardElife = [
    "elife-test.pdf",
    "Mechanisms of Cellular Signaling",
    "2023 · Author Name",
    "eLife",
    "This paper presents structural insights into receptor phosphorylation dynamics.",
  ].join("\n");
  const metaElife = extractSciSpaceCardMeta(cardElife, "elife-test.pdf");
  assert.equal(metaElife.venue, "eLife");
  assert.match(metaElife.paste, /eLife$/);

  const cardNpj = [
    "npj-test.pdf",
    "Fault-Tolerant Quantum Computation",
    "2024 · Author Name",
    "npj Quantum Information",
    "This paper explores threshold theorems for topological quantum error correction.",
  ].join("\n");
  const metaNpj = extractSciSpaceCardMeta(cardNpj, "npj-test.pdf");
  assert.equal(metaNpj.venue, "npj Quantum Information");
  assert.match(metaNpj.paste, /npj Quantum Information$/);
});

test("bibliography regression: DOI / journal UI labels never become authors or venue", () => {
  for (const label of ["DOI", "journal", "Authors", "掲載誌", "DOI:"]) {
    const raw = ["agronomy-09-00403.pdf", "AgROS: A Robot Operating System Based Emulation", `2019⋅${label}`, label].join("\n");
    const card = extractSciSpaceCardMeta(raw, "agronomy-09-00403.pdf");
    assert.equal(card.authors, "", label);
    assert.equal(card.yearAuthorLine, "", label);
    assert.equal(card.venue, "", label);
    const paste = eduShareSciSpaceMetadataPaste(raw, "agronomy-09-00403.pdf");
    assert.doesNotMatch(paste, /2019/);
    assert.equal(venueLooksLikeBadSciSpaceCapture(label), true);
  }
});

test("bibliography regression: author names cannot be reused as the venue", () => {
  const raw = ["agronomy-09-00403.pdf", "AgROS: A Robot Operating System Based Emulation", "2019⋅Naoum Tsolakis, Dimitrios Bechtsis", "Naoum Tsolakis", "journal", "Agronomy"].join("\n");
  assert.equal(extractSciSpaceCardMeta(raw, "agronomy-09-00403.pdf").venue, "Agronomy");
});

test("bibliography regression: preserve full saved title and venue in the actual outgoing paste", () => {
  const short = "AgROS: A Robot Operating System Based Emulation";
  const full = `${short} Tool for Agricultural Robotics`;
  const raw = ["agronomy-09-00403.pdf", short, "2019⋅Naoum Tsolakis", "Other Journal"].join("\n");
  const paste = eduShareSciSpaceMetadataPaste(raw, "agronomy-09-00403.pdf", { currentTitle: full, currentVenue: "Agronomy" });
  assert.match(paste, /Emulation Tool for Agricultural Robotics/);
  assert.match(paste, /Agronomy/);
  assert.doesNotMatch(paste, /Other Journal/);
  assert.equal(titleLooksLikeBadSciSpaceCapture(`${short}…`), true);
  assert.doesNotMatch(eduShareSciSpaceMetadataPaste(raw.replace(short, `${short}…`), "agronomy-09-00403.pdf"), /Emulation/);
});

test("venue fallback without an author line requires an explicit venue hint", () => {
  const title = "AgROS: A Robot Operating System Based Emulation";
  assert.equal(extractSciSpaceCardMeta(`paper.pdf\n${title}\nNaoum Tsolakis`, "paper.pdf").venue, "");
  assert.equal(extractSciSpaceCardMeta(`paper.pdf\n${title}\nJournal of Agricultural Robotics`, "paper.pdf").venue, "Journal of Agricultural Robotics");
});

test("outgoing partial metadata cannot become a wrong title or author in the real app parser", async () => {
  // Import by URL at runtime: the application parser belongs to a separate TypeScript package.
  const appParser = new URL("../../../src/lib/paper-metadata-paste.ts", import.meta.url).href;
  const { parsePaperMetadataPaste } = await import(appParser) as {
    parsePaperMetadataPaste: (text: string) => { title: string; authors: string; venue: string };
  };
  const raw = "paper.pdf\nTruncated Article Title…\n2023 · Alice Smith\nJournal of Software and Systems";
  const noTitle = eduShareSciSpaceMetadataPaste(raw, "paper.pdf", { sciTitleRejected: true });
  const parsed = parsePaperMetadataPaste(noTitle);
  assert.equal(parsed.title, "");
  assert.equal(parsed.authors, "Alice Smith");
  assert.equal(parsed.venue, "Journal of Software and Systems");
  const noAuthors = eduShareSciSpaceMetadataPaste(raw.replace("2023 · Alice Smith", "2023 · DOI"), "paper.pdf", { currentTitle: "Complete Verified Article Title", currentVenue: "Journal of Software and Systems" });
  const absent = parsePaperMetadataPaste(noAuthors);
  assert.equal(absent.title, "Complete Verified Article Title");
  assert.equal(absent.authors, "");
  assert.equal(absent.venue, "");
});

test("issue #131: looksLikePageRange ページ範囲の判定", () => {
  assert.equal(looksLikePageRange(", pages 11095–11111"), true);
  assert.equal(looksLikePageRange("pages 11095–11111"), true);
  assert.equal(looksLikePageRange(", pp. 11095-11111"), true);
  assert.equal(looksLikePageRange("pp. 11095–11111"), true);
  assert.equal(looksLikePageRange("p. 11095"), true);
  assert.equal(looksLikePageRange("11095–11111"), true);
  assert.equal(looksLikePageRange(", 11095-11111"), true);
  // 通常のタイトル
  assert.equal(looksLikePageRange("Pages from the History of Science"), false);
  assert.equal(looksLikePageRange("A Comprehensive Survey of Neural Networks"), false);
  assert.equal(looksLikePageRange("p53 mutations in human cancers"), false);
  assert.equal(looksLikePageRange("p21 expression in cell cycle arrest"), false);
});

test("issue #131: looksLikeEditorField 編集者欄の判定", () => {
  assert.equal(looksLikeEditorField("Academic Editors: …"), true);
  assert.equal(looksLikeEditorField("Academic Editors: John Doe, Jane Smith"), true);
  assert.equal(looksLikeEditorField("Academic Editor: John Doe"), true);
  assert.equal(looksLikeEditorField("Editors: Alice Bob"), true);
  assert.equal(looksLikeEditorField("Edited by Charles Darwin"), true);
  assert.equal(looksLikeEditorField("編集者: 山田太郎"), true);
  assert.equal(looksLikeEditorField("編集委員: 佐藤次郎"), true);
  // 通常のタイトル
  assert.equal(looksLikeEditorField("Editorial Board Decisions in Modern Science"), false);
  assert.equal(looksLikeEditorField("The Editor's Guide to Machine Learning"), false);
  assert.equal(looksLikeEditorField("Editor bias in peer review"), false);
  assert.equal(looksLikeEditorField("Editors as gatekeepers in scholarly publishing"), false);
});

test("issue #131: isTitlePrefixOf 途中切れプレフィックスの判定", () => {
  const full = "AI models collapse when trained on recursively generated data";
  assert.equal(isTitlePrefixOf("AI models collapse when trained on", full), true);
  assert.equal(isTitlePrefixOf("AI models collapse when trained on...", full), true);
  assert.equal(isTitlePrefixOf("AI models collapse when trained on -", full), true);
  assert.equal(isTitlePrefixOf("AI models collapse when trained on …", full), true);
  // 完全一致は prefix ではない
  assert.equal(isTitlePrefixOf(full, full), false);
  // 別タイトル
  assert.equal(isTitlePrefixOf("Attention Is All You Need", full), false);
  // 候補の方が長い
  assert.equal(isTitlePrefixOf(`${full} extra words`, full), false);
});

test("issue #131: titleLooksLikeVenueOrConference 会議名・識別子の判定", () => {
  assert.equal(titleLooksLikeVenueOrConference("56_244"), true);
  assert.equal(titleLooksLikeVenueOrConference("sec18-zhang_0"), true);
  assert.equal(titleLooksLikeVenueOrConference("Agronomy", "Agronomy"), true);
  assert.equal(titleLooksLikeVenueOrConference("Journal"), true);
  assert.equal(titleLooksLikeVenueOrConference("Deep Residual Learning for Image Recognition"), false);
});

test("issue #131: titleLooksLikeBadSciSpaceCapture でページ範囲・編集者・識別コードを弾く", () => {
  assert.equal(titleLooksLikeBadSciSpaceCapture(", pages 11095–11111"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("Academic Editors: …"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("Academic Editors: John Doe"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("56_244"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("sec18-zhang_0"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("075310_1_5.0100358.pdf"), true);
  assert.equal(titleLooksLikeBadSciSpaceCapture("Not addressed in the paper."), true);
  // 正しいタイトルが誤判定されないこと
  assert.equal(titleLooksLikeBadSciSpaceCapture("p53 mutations in human cancers"), false);
  assert.equal(titleLooksLikeBadSciSpaceCapture("Editor bias in peer review"), false);
});

test("issue #131: reconcileMetaFromFilesPaste で途中切れや不正タイトルを完全な題名に戻す", () => {
  // 途中切れ
  const fullTitle = "AI models collapse when trained on recursively generated data";
  const stateTruncated = {
    title: "AI models collapse when trained on",
    venue: "Nature",
    doi: "10.1038/s41586-024-07566-y",
    filesPaste: `s41586-024-07566-y.pdf\n${fullTitle}\n2024 · Ilia Shumailov\nNature`,
    filename: "s41586-024-07566-y.pdf",
  };
  assert.equal(reconcileMetaFromFilesPaste(stateTruncated), true);
  assert.equal(stateTruncated.title, fullTitle);

  // ページ範囲
  const statePageRange = {
    title: ", pages 11095–11111",
    venue: "Findings of ACL",
    doi: "",
    filesPaste: "2024.findings-acl.660.pdf\nContext-Aware Dialogue Generation\n2024 · Author\nFindings of ACL",
    filename: "2024.findings-acl.660.pdf",
  };
  assert.equal(reconcileMetaFromFilesPaste(statePageRange), true);
  assert.equal(statePageRange.title, "Context-Aware Dialogue Generation");

  // 会議・論文識別コード
  const stateConfCode = {
    title: "sec18-zhang_0",
    venue: "USENIX Security",
    doi: "",
    filesPaste: "sec18-zhang_0.pdf\nTowards Automated Security Analysis of Smart Contracts\n2018 · Alice Zhang\nUSENIX Security",
    filename: "sec18-zhang_0.pdf",
  };
  assert.equal(reconcileMetaFromFilesPaste(stateConfCode), true);
  assert.equal(stateConfCode.title, "Towards Automated Security Analysis of Smart Contracts");
});

test("Issue #132: stripShowLess は末尾の Show Less 表記を除去する", () => {
  assert.equal(stripShowLess("Trung BuiShow Less"), "Trung Bui");
  assert.equal(stripShowLess("Trung Bui Show Less"), "Trung Bui");
  assert.equal(stripShowLess("Trung Bui - Show Less"), "Trung Bui");
  assert.equal(stripShowLess("Trung Bui · Show Less"), "Trung Bui");
  assert.equal(stripShowLess("Show Less"), "");
  assert.equal(
    stripShowLess("2025 · Vardhan Dongre, Ryan A. Rossi, Dilek Hakkani-Tür, Trung BuiShow Less"),
    "2025 · Vardhan Dongre, Ryan A. Rossi, Dilek Hakkani-Tür, Trung Bui",
  );
});

test("Issue #132: stripTruncatedMore は +N More 表記を除去する", () => {
  assert.equal(stripTruncatedMore("Raad Khraishi, Iman Zafar ...+2 More"), "Raad Khraishi, Iman Zafar");
  assert.equal(stripTruncatedMore("Raad Khraishi, Iman Zafar +2 More"), "Raad Khraishi, Iman Zafar");
  assert.equal(stripTruncatedMore("Raad Khraishi, Iman Zafar, ...+2 More"), "Raad Khraishi, Iman Zafar");
  assert.equal(stripTruncatedMore("+2 More"), "");
  assert.equal(stripTruncatedMore("...+4 More"), "");
});

test("Issue #132: filesRowHasTruncatedAuthors はドット無し +N More も検出する", () => {
  assert.equal(filesRowHasTruncatedAuthors("2025 · Vardhan Dongre +4 More"), true);
  assert.equal(filesRowHasTruncatedAuthors("2025 · Vardhan Dongre ...+4 More"), true);
  assert.equal(filesRowHasTruncatedAuthors("2025 · Vardhan Dongre"), false);
  assert.equal(filesRowHasTruncatedAuthors("2025 · Vardhan Dongre Show Less"), false);
});

test("Issue #132: extractSciSpaceCardMeta は card.authors に Show Less も +N More も残さない", () => {
  const rowWithShowLess = [
    "model-collapse-2024.pdf",
    "Model Collapse in Multi-Turn LLMs",
    "2024 · Ilia Shumailov, Zakhar Shumaylov, Yarin GalShow Less",
    "Nature",
  ].join("\n");
  const metaLess = extractSciSpaceCardMeta(rowWithShowLess, "model-collapse-2024.pdf");
  assert.equal(metaLess.authors, "Ilia Shumailov, Zakhar Shumaylov, Yarin Gal");
  assert.doesNotMatch(metaLess.authors, /Show\s*Less/i);
  assert.doesNotMatch(metaLess.yearAuthorLine, /Show\s*Less/i);
  assert.doesNotMatch(metaLess.paste, /Show\s*Less/i);

  const rowWithMore = [
    "sigcomm20.pdf",
    "Lognic: High-speed Network Systems",
    "2020 · Alice Smith, Bob Jones ...+3 More",
    "ACM SIGCOMM",
  ].join("\n");
  const metaMore = extractSciSpaceCardMeta(rowWithMore, "sigcomm20.pdf");
  assert.equal(metaMore.authors, "Alice Smith, Bob Jones");
  assert.doesNotMatch(metaMore.authors, /\+3\s*More/i);

  const rowOnlyMore = [
    "2505.06120v1.pdf",
    "A Machine Learning Paper",
    "2025 · ...+5 More",
    "arXiv",
  ].join("\n");
  const metaOnlyMore = extractSciSpaceCardMeta(rowOnlyMore, "2505.06120v1.pdf");
  assert.equal(metaOnlyMore.authors, "");
});


test("Issue #143: 著者省略判定は年著者行だけを見る", () => {
  for (const body of ["The paper compares +2 more methods.", "TL;DR: +2 More", "A title +2 More"]) {
    assert.equal(filesRowHasTruncatedAuthors(`paper.pdf\n${body}\n2025 · Alice Smith\n${body}`), false);
  }
  assert.equal(filesRowHasTruncatedAuthors("+2 More"), false);
  assert.equal(filesRowHasTruncatedAuthors("paper.pdf Title 2025 · Alice Smith +2 More arXiv The paper compares methods."), true);
  assert.equal(filesRowHasTruncatedAuthors("paper.pdf Title 2025 · Alice Smith arXiv The paper compares +2 more methods."), false);
  assert.equal(filesRowHasTruncatedAuthors("2025 · Alice Smith TL;DR: +2 More"), false);
  assert.equal(filesRowHasTruncatedAuthors("2025 · Alice Smith +2 More\nTL;DR: Show Less"), true);
  assert.equal(filesRowHasTruncatedAuthors("2025 · Alice Smith Show Less\nTL;DR: +2 More"), false);
});
