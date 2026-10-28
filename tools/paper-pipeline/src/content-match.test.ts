import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  arxivIdsMatch,
  extractPaperContentKeyFromPdf,
  extractPaperContentKeyFromState,
  filterDuplicateInboxPdfs,
  findContentDuplicateMatch,
  firstAuthorsMatch,
  matchPaperContent,
  movePdfToHold,
  normalizeArxivId,
  normalizeFirstAuthor,
  parseFirstPageTitleAndAuthor,
  type MatchTarget,
  type PaperContentKey,
} from "./content-match.ts";

test("normalizeArxivId: 各種 arXiv 表記から版番号を無視して正規化できる", () => {
  assert.equal(normalizeArxivId("arXiv:physics/9905030v1 [physics.hist-ph] 12 May 1999"), "physics/9905030");
  assert.equal(normalizeArxivId("arXiv:physics/9905030v2"), "physics/9905030");
  assert.equal(normalizeArxivId("physics/9905030"), "physics/9905030");
  assert.equal(normalizeArxivId("arXiv:0709.2257v2 [gr-qc] 25 Oct 2007"), "0709.2257");
  assert.equal(normalizeArxivId("0709.2257v2.pdf"), "0709.2257");
  assert.equal(normalizeArxivId("0709.2257"), "0709.2257");
  assert.equal(normalizeArxivId("arXiv:2301.00123v3"), "2301.00123");
  assert.equal(normalizeArxivId("https://arxiv.org/abs/1310.6541v1"), "1310.6541");
  assert.equal(normalizeArxivId("9905030v1.pdf"), "9905030");
  assert.equal(normalizeArxivId(""), "");
  assert.equal(normalizeArxivId("unrelated-random-file.pdf"), "");
});

test("arxivIdsMatch: 版番号無視および旧形式カテゴリ付き/無しの照合", () => {
  assert.ok(arxivIdsMatch("physics/9905030", "physics/9905030"));
  assert.ok(arxivIdsMatch("physics/9905030", "9905030"));
  assert.ok(arxivIdsMatch("9905030", "physics/9905030"));
  assert.ok(arxivIdsMatch("0709.2257", "0709.2257"));
  assert.equal(arxivIdsMatch("0709.2257", "physics/9905030"), false);
  assert.equal(arxivIdsMatch("0709.2257", "1310.6541"), false);
  assert.equal(arxivIdsMatch("", "0709.2257"), false);
});

test("normalizeFirstAuthor and firstAuthorsMatch: 筆頭著者の姓名を正規化して一致判定", () => {
  assert.equal(normalizeFirstAuthor("Karl Schwarzschild"), "schwarzschild");
  assert.equal(normalizeFirstAuthor("K. Schwarzschild"), "schwarzschild");
  assert.equal(normalizeFirstAuthor("by K. Schwarzschild"), "schwarzschild");
  assert.equal(normalizeFirstAuthor("1999 · K. Schwarzschild, S. Antoci, A. Loinger"), "schwarzschild");
  assert.equal(normalizeFirstAuthor("1999⋅K. Schwarzschild, S. Antoci...+1 More"), "schwarzschild");
  assert.equal(normalizeFirstAuthor("Lluís Bel"), "bel");
  assert.equal(normalizeFirstAuthor("Bel, Lluís"), "bel");
  assert.equal(normalizeFirstAuthor("Albert Einstein"), "einstein");
  assert.equal(normalizeFirstAuthor("Galina Weinstein"), "weinstein");

  // 一致
  assert.ok(firstAuthorsMatch("Karl Schwarzschild", "K. Schwarzschild"));
  assert.ok(firstAuthorsMatch("K. Schwarzschild", "1999 · K. Schwarzschild, S. Antoci"));
  assert.ok(firstAuthorsMatch("Lluís Bel", "Bel, Lluís"));

  // 不一致
  assert.equal(firstAuthorsMatch("Lluís Bel", "Karl Schwarzschild"), false);
  assert.equal(firstAuthorsMatch("Lluís Bel", "Albert Einstein"), false);
  assert.equal(firstAuthorsMatch("Galina Weinstein", "Albert Einstein"), false);
  assert.equal(firstAuthorsMatch("", "Karl Schwarzschild"), false);
});

test("matchPaperContent 実例: 9905030v1 と 9905030v1_ は一致する", () => {
  const paperA: PaperContentKey = {
    arxivId: "physics/9905030",
    title: "On the Gravitational Field of a Mass Point according to Einstein's Theory",
    firstAuthor: "K. Schwarzschild",
  };
  const paperB: PaperContentKey = {
    arxivId: "physics/9905030",
    title: "ON THE GRAVITATIONAL FIELD OF A MASS POINT ACCORDING TO EINSTEIN'S THEORY",
    firstAuthor: "Karl Schwarzschild",
  };
  const res = matchPaperContent(paperA, paperB);
  assert.ok(res.matched, "9905030v1 and 9905030v1_ should match");
  assert.match(res.reason ?? "", /arXiv ID/);
});

test("matchPaperContent 実例: 0709.2257v2 と Schwarzschild-1916 / Einstein 系は不一致", () => {
  // 0709.2257v2: 題名は Schwarzschild 論文と同じだが著者は Lluís Bel
  const belPaper: PaperContentKey = {
    arxivId: "0709.2257",
    title: "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    firstAuthor: "Lluís Bel",
  };
  const schwarzschildPaper: PaperContentKey = {
    arxivId: "physics/9905030",
    title: "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    firstAuthor: "Karl Schwarzschild",
  };
  const einsteinPaper: PaperContentKey = {
    arxivId: "1310.6541",
    title: "Einstein's 1916 derivation of the Field Equations",
    firstAuthor: "Galina Weinstein",
  };

  // 0709.2257v2 vs Schwarzschild: 題名は同じだが arXiv ID・筆頭著者が異なるため不一致
  const res1 = matchPaperContent(belPaper, schwarzschildPaper);
  assert.equal(res1.matched, false, "0709.2257v2 must NOT match Schwarzschild paper");

  // 0709.2257v2 vs Einstein-1916: 不一致
  const res2 = matchPaperContent(belPaper, einsteinPaper);
  assert.equal(res2.matched, false, "0709.2257v2 must NOT match Einstein derivation paper");
});

test("matchPaperContent: 題名だけでは一致にしない（筆頭著者が異なるか欠落の場合は不一致）", () => {
  const paper1: PaperContentKey = {
    title: "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    firstAuthor: "Lluís Bel",
  };
  const paper2: PaperContentKey = {
    title: "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
    firstAuthor: "Karl Schwarzschild",
  };
  const paperNoAuthor: PaperContentKey = {
    title: "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
  };

  assert.equal(matchPaperContent(paper1, paper2).matched, false);
  assert.equal(matchPaperContent(paper1, paperNoAuthor).matched, false);
  assert.equal(matchPaperContent(paperNoAuthor, paperNoAuthor).matched, false);
});

test("matchPaperContent: DOI 一致が最優先", () => {
  const a: PaperContentKey = {
    doi: "10.1234/example.100",
    title: "Different Title Variant A",
  };
  const b: PaperContentKey = {
    doi: "10.1234/example.100",
    title: "Different Title Variant B",
  };
  const c: PaperContentKey = {
    doi: "10.9999/different",
    title: "Different Title Variant B",
  };

  const res = matchPaperContent(a, b);
  assert.ok(res.matched);
  assert.match(res.reason ?? "", /DOI/);

  assert.equal(matchPaperContent(a, c).matched, false);
});

test("matchPaperContent: キーが一つも取れない PDF は一致しない（誤って止めない）", () => {
  const emptyKey: PaperContentKey = {};
  const validKey: PaperContentKey = {
    doi: "10.1234/test",
    arxivId: "2301.00001",
    title: "Valid Paper",
    firstAuthor: "Author",
  };

  assert.equal(matchPaperContent(emptyKey, validKey).matched, false);
  assert.equal(matchPaperContent(emptyKey, emptyKey).matched, false);
  assert.equal(findContentDuplicateMatch(emptyKey, [{ key: validKey, label: "target" }]).matched, false);
});

test("extractPaperContentKeyFromState: state.json から各キーを取り出す", () => {
  const state = {
    filename: "9905030v1.pdf",
    title: "ON THE GRAVITATIONAL FIELD OF A MASS POINT ACCORDING TO EINSTEIN'S THEORY",
    doi: "10.1000/182",
    venue: "arXiv:physics/9905030v1 [physics.hist-ph]",
    filesPaste: "9905030v1.pdf\nON THE GRAVITATIONAL FIELD OF A MASS POINT ACCORDING TO EINSTEIN'S THEORY\n1999⋅K. Schwarzschild, S. Antoci...+1 More\narXiv:physics/9905030v1 [physics.hist-ph]",
  };
  const key = extractPaperContentKeyFromState(state);
  assert.equal(key.doi, "10.1000/182");
  assert.equal(key.arxivId, "physics/9905030");
  assert.equal(key.title, "ON THE GRAVITATIONAL FIELD OF A MASS POINT ACCORDING TO EINSTEIN'S THEORY");
  assert.equal(normalizeFirstAuthor(key.firstAuthor ?? ""), "schwarzschild");
});

test("movePdfToHold: PDF を hold/ ディレクトリへ移動し元の場所からは削除される", () => {
  const testDir = join(tmpdir(), `pp-hold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const inboxDir = join(testDir, "inbox");
  const holdDir = join(testDir, "hold");
  mkdirSync(inboxDir, { recursive: true });

  const testFile = join(inboxDir, "test-paper.pdf");
  writeFileSync(testFile, "dummy pdf content", "utf8");

  assert.ok(existsSync(testFile));
  const dest = movePdfToHold(testFile, holdDir);

  assert.equal(dest, join(holdDir, "test-paper.pdf"));
  assert.ok(existsSync(dest));
  assert.equal(existsSync(testFile), false);

  rmSync(testDir, { recursive: true, force: true });
});

test("filterDuplicateInboxPdfs: 重複した inbox PDF を hold/ へ移動し未重複のみ残す", async () => {
  const testDir = join(tmpdir(), `pp-filter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const inboxDir = join(testDir, "inbox");
  const holdDir = join(testDir, "hold");
  mkdirSync(inboxDir, { recursive: true });

  const file1 = join(inboxDir, "0709.2257v2.pdf");
  const file2 = join(inboxDir, "9905030v1.pdf");
  const file3 = join(inboxDir, "9905030v1_.pdf");

  writeFileSync(file1, "pdf1", "utf8");
  writeFileSync(file2, "pdf2", "utf8");
  writeFileSync(file3, "pdf3", "utf8");

  const inboxItems = [
    { filename: "0709.2257v2.pdf", absPath: file1, stem: "0709.2257v2", paperDir: "" },
    { filename: "9905030v1.pdf", absPath: file2, stem: "9905030v1", paperDir: "" },
    { filename: "9905030v1_.pdf", absPath: file3, stem: "9905030v1_", paperDir: "" },
  ];

  // 照合先ターゲット: work に Schwarzschild 1916 (physics/9905030) が既に存在
  const targets: MatchTarget[] = [
    {
      key: {
        arxivId: "physics/9905030",
        title: "ON THE GRAVITATIONAL FIELD OF A MASS POINT ACCORDING TO EINSTEIN'S THEORY",
        firstAuthor: "Karl Schwarzschild",
      },
      label: "work/ON-THE-GRAVITATIONAL-FIELD-OF-A-MASS-POINT",
      filename: "ON-THE-GRAVITATIONAL-FIELD-OF-A-MASS-POINT.pdf",
    },
  ];

  const fakeKeys: Record<string, PaperContentKey> = {
    [file1]: {
      arxivId: "0709.2257",
      title: "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie",
      firstAuthor: "Lluís Bel",
    },
    [file2]: {
      arxivId: "physics/9905030",
      title: "On the Gravitational Field of a Mass Point according to Einstein's Theory",
      firstAuthor: "K. Schwarzschild",
    },
    [file3]: {
      arxivId: "physics/9905030",
      title: "On the Gravitational Field of a Mass Point according to Einstein's Theory",
      firstAuthor: "K. Schwarzschild",
    },
  };

  const kept = await filterDuplicateInboxPdfs(inboxItems, targets, holdDir, {
    extractKey: async (path) => (typeof path === "string" ? fakeKeys[path] ?? {} : {}),
  });

  // 0709.2257v2.pdf は別論文なので残る
  assert.equal(kept.some((k) => k.filename === "0709.2257v2.pdf"), true);

  // 9905030v1.pdf と 9905030v1_.pdf は work の existing と一致するので hold/ へ移動される
  assert.equal(kept.some((k) => k.filename === "9905030v1.pdf"), false);
  assert.equal(kept.some((k) => k.filename === "9905030v1_.pdf"), false);
  assert.ok(existsSync(join(holdDir, "9905030v1.pdf")));
  assert.ok(existsSync(join(holdDir, "9905030v1_.pdf")));

  rmSync(testDir, { recursive: true, force: true });
});

test("filterDuplicateInboxPdfs: 同じ実行中の inbox 同士の重複を検知し後勝ち/先勝ちで片方を hold/ へ移動", async () => {
  const testDir = join(tmpdir(), `pp-filter-inbox-dup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const inboxDir = join(testDir, "inbox");
  const holdDir = join(testDir, "hold");
  mkdirSync(inboxDir, { recursive: true });

  const fileA = join(inboxDir, "9905030v1.pdf");
  const fileB = join(inboxDir, "9905030v1_.pdf");

  writeFileSync(fileA, "pdfA", "utf8");
  writeFileSync(fileB, "pdfB", "utf8");

  const inboxItems = [
    { filename: "9905030v1.pdf", absPath: fileA, stem: "9905030v1", paperDir: "" },
    { filename: "9905030v1_.pdf", absPath: fileB, stem: "9905030v1_", paperDir: "" },
  ];

  const fakeKeys: Record<string, PaperContentKey> = {
    [fileA]: {
      arxivId: "physics/9905030",
      title: "On the Gravitational Field of a Mass Point according to Einstein's Theory",
      firstAuthor: "K. Schwarzschild",
    },
    [fileB]: {
      arxivId: "physics/9905030",
      title: "On the Gravitational Field of a Mass Point according to Einstein's Theory",
      firstAuthor: "K. Schwarzschild",
    },
  };

  // work や duplicates には何も無い状態
  const targets: MatchTarget[] = [];

  const kept = await filterDuplicateInboxPdfs(inboxItems, targets, holdDir, {
    extractKey: async (path) => (typeof path === "string" ? fakeKeys[path] ?? {} : {}),
  });

  // 1件目は残る、2件目は1件目と一致して hold/ へ移動
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.filename, "9905030v1.pdf");
  assert.ok(existsSync(join(holdDir, "9905030v1_.pdf")));

  rmSync(testDir, { recursive: true, force: true });
});
