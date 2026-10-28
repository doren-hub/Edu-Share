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
  // 本文中の無関係な 7 桁数字（電話番号や助成番号など）を誤って arXiv ID とみなさない
  assert.equal(normalizeArxivId("Grant number 1234567 in text"), "");
});

test("arxivIdsMatch: 版番号無視および旧形式カテゴリ付き/無しの照合（カテゴリ不一致は除外）", () => {
  assert.ok(arxivIdsMatch("physics/9905030", "physics/9905030"));
  assert.ok(arxivIdsMatch("physics/9905030", "9905030"));
  assert.ok(arxivIdsMatch("9905030", "physics/9905030"));
  assert.ok(arxivIdsMatch("0709.2257", "0709.2257"));

  // カテゴリが異なる旧形式 arXiv ID（physics vs hep-th）は一致しない
  assert.equal(arxivIdsMatch("physics/9905030", "hep-th/9905030"), false);

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

test("parseFirstPageTitleAndAuthor: 実際の 1 ページ目テキストから題名と筆頭著者を抽出できる", () => {
  // 9905030v1 の 1 ページ目抽出テキスト
  const schwarzschildText = `
arXiv:physics/9905030v1  [physics.hist-ph]  12 May 1999
On the Gravitational Field of a Mass Point
according to Einstein’s Theory†
by K. Schwarzschild
(Communicated January 13th, 1916 [see above p. 42].)
translation‡and foreword by
S. Antoci
∗
and A. Loinger
Foreword. This fundamental memoir contains...
`;
  const res1 = parseFirstPageTitleAndAuthor(schwarzschildText);
  assert.equal(res1.title, "On the Gravitational Field of a Mass Point according to Einstein’s Theory†");
  assert.equal(res1.author, "K. Schwarzschild");

  // 0709.2257v2 の 1 ページ目抽出テキスト（Lluís Bel）
  const belText = `
arXiv:0709.2257v2 [gr-qc] 25 Oct 2007
Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie
Lluís Bel
Abstract
We re-examine the Schwarzschild problem in general relativity...
`;
  const res2 = parseFirstPageTitleAndAuthor(belText);
  assert.equal(res2.title, "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie");
  assert.equal(res2.author, "Lluís Bel");
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

test("extractPaperContentKeyFromPdf: 有効な PDF バッファから題名を抽出できる", async () => {
  const base64Pdf =
    "JVBERi0xLjQKJcfsj6IKJSVJbnZvY2F0aW9uOiBncyAtc0RFVklDRT1wZGZ3cml0ZSAtZENvbXBhdGliaWxpdHlMZXZlbD0xLjQgLWROT1BBVVNFIC1kUVVJRVQgLWRCQVRDSCAtc091dHB1dEZpbGU9PyA/ID8KNSAwIG9iago8PC9MZW5ndGggNiAwIFIvRmlsdGVyIC9GbGF0ZURlY29kZT4+CnN0cmVhbQp4nCtUMNAzVDAAQSidnMtloJDOVchlCBZVgFLJuQpOIVz6QeYKhkYKIWlcEMWGCqYGCuYGBgohuVwaLqmpBQpBqcWZKaWJOQo+qYlFeZl56ZohWVyuIVyBQAgA27cZGWVuZHN0cmVhbQplbmRvYmoKNiAwIG9iago5NQplbmRvYmoKNCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXQovUm90YXRlIDAvUGFyZW50IDMgMCBSCi9SZXNvdXJjZXM8PC9Qcm9jU2V0Wy9QREYgL1RleHRdCi9Gb250IDggMCBSCj4+Ci9Db250ZW50cyA1IDAgUgo+PgplbmRvYmoKMyAwIG9iago8PCAvVHlwZSAvUGFnZXMgL0tpZHMgWwo0IDAgUgpdIC9Db3VudCAxCj4+CmVuZG9iagoxIDAgb2JqCjw8L1R5cGUgL0NhdGFsb2cgL1BhZ2VzIDMgMCBSCi9NZXRhZGF0YSAxMCAwIFIKPj4KZW5kb2JqCjggMCBvYmoKPDwvUjcKNyAwIFI+PgplbmRvYmoKOSAwIG9iago8PC9GaWx0ZXIvRmxhdGVEZWNvZGUvTGVuZ3RoIDI1NT4+c3RyZWFtCnicXZHBboMwEETv/gr/AYYEW0hoL8klh1ZV2x8gZok4xFgOOeTvM7skPfQwIz3Y1Q5DdTgdT2lebfVVlvjDq53mNBa+LfcS2Z75MidTN3ac4/oi9XgdsqkOH0P+fWS2GOBp48/hytV3pw/qbSUuI9/yELkM6cKmd476aSLDafz3qm63jfP0Gm0wKnIObvr9nlTOwYGRVMAIbBtSOQc3va9J5RwciD2vu152fUsqYCsYSAUMgh2pgJ0gjng95OWQZ1IBGRgQMGjIICEDIgSNESRG2JEKuBPEzaB34VLB+1ulDWn1XaKN91I4rVq9Viudzon//k5esmxZyDwBycR/ygplbmRzdHJlYW0KZW5kb2JqCjcgMCBvYmoKPDwvQmFzZUZvbnQvSGVsdmV0aWNhL1RvVW5pY29kZSA5IDAgUi9UeXBlL0ZvbnQKL1N1YnR5cGUvVHlwZTE+PgplbmRvYmoKMTAgMCBvYmoKPDwvVHlwZS9NZXRhZGF0YQovU3VidHlwZS9YTUwvTGVuZ3RoIDE0NTc+PnN0cmVhbQo8P3hwYWNrZXQgYmVnaW49J++7vycgaWQ9J1c1TTBNcENlaGlIenJlU3pOVGN6a2M5ZCc/Pgo8P2Fkb2JlLXhhcC1maWx0ZXJzIGVzYz0iQ1JMRiI/Pgo8eDp4bXBtZXRhIHhtbG5zOng9J2Fkb2JlOm5zOm1ldGEvJyB4OnhtcHRrPSdYTVAgdG9vbGtpdCAyLjkuMS0xMywgZnJhbWV3b3JrIDEuNic+CjxyZGY6UkRGIHhtbG5zOnJkZj0naHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIycgeG1sbnM6aVg9J2h0dHA6Ly9ucy5hZG9iZS5jb20vaVgvMS4wLyc+CjxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiIHhtbG5zOnBkZj0naHR0cDovL25zLmFkb2JlLmNvbS9wZGYvMS4zLycgcGRmOlByb2R1Y2VyPSdHUEwgR2hvc3RzY3JpcHQgMTAuMDcuMScvPgo8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9J2h0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8nPjx4bXA6TW9kaWZ5RGF0ZT4yMDI2LTEwLTE0VDE0OjAxOjA4KzA5OjAwPC94bXA6TW9kaWZ5RGF0ZT4KPHhtcDpDcmVhdGVEYXRlPjIwMjYtMTAtMTRUMTQ6MDE6MDgrMDk6MDA8L3htcDpDcmVhdGVEYXRlPgo8eG1wOk1ldGFkYXRhRGF0ZT4yMDI2LTEwLTE0VDE0OjAxOjA4KzA5OjAwPC94bXA6TWV0YWRhdGFEYXRlPgo8eG1wOkNyZWF0b3JUb29sPidVbmtub3duQXBwbGljYXRpb24nPC94bXA6Q3JlYXRvclRvb2w+PC9yZGY6RGVzY3JpcHRpb24+CjxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiIHhtbG5zOnhtcE1NPSdodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vJyB4bXBNTTpEb2N1bWVudElEPSd1dWlkOmQxMmJmMDM0LWZmYTgtMTFmYy0wMDAwLWRjYmRmN2MzMDUzYScvPgo8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXBNTT0naHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLycgeG1wTU06UmVuZGl0aW9uQ2xhc3M9J2RlZmF1bHQnLz4KPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wTU09J2h0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8nIHhtcE1NOlZlcnNpb25JRD0nMScvPgo8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczpkYz0naHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8nIGRjOmZvcm1hdD0nYXBwbGljYXRpb24vcGRmJz48ZGM6dGl0bGU+PHJkZjpBbHQ+PHJkZjpsaSB4bWw6bGFuZz0neC1kZWZhdWx0Jz4nVW50aXRsZWQnPC9yZGY6bGk+PC9yZGY6QWx0PjwvZGM6dGl0bGU+PC9yZGY6RGVzY3JpcHRpb24+CjwvcmRmOlJERj4KPC94OnhtcG1ldGE+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVuZD0ndyc/PgplbmRzdHJlYW0KZW5kb2JqCjIgMCBvYmoKPDwvUHJvZHVjZXIoR1BMIEdob3N0c2NyaXB0IDEwLjA3LjEpCi9DcmVhdGlvbkRhdGUoRDoyMDI2MTAxNDE0MDEwOCswOScwMCcpCi9Nb2REYXRlKEQ6MjAyNjEwMTQxNDAxMDgrMDknMDAnKT4+ZW5kb2JqCnhyZWYKMCAxMQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDA1MDMgMDAwMDAgbiAKMDAwMDAwMjUzMyAwMDAwMCBuIAowMDAwMDAwNDQ0IDAwMDAwIG4gCjAwMDAwMDAzMDMgMDAwMDAgbiAKMDAwMDAwMDEyMCAwMDAwMCBuIAowMDAwMDAwMjg1IDAwMDAwIG4gCjAwMDAwMDA5MTkgMDAwMDAgbiAKMDAwMDAwMDU2OCAwMDAwMCBuIAowMDAwMDAwNTk3IDAwMDAwIG4gCjAwMDAwMDA5OTkgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSAxMSAvUm9vdCAxIDAgUiAvSW5mbyAyIDAgUgovSUQgWzxEQjcwNjVBOTU3N0Y4MjkwNjNBOEI1NEUxNzQ5NDlDMz48REI3MDY1QTk1NzdGODI5MDYzQThCNTRFMTc0OTQ5QzM+XQo+PgpzdGFydHhyZWYKMjY1OQolJUVPRgo=";
  const key = await extractPaperContentKeyFromPdf(Buffer.from(base64Pdf, "base64"));
  assert.equal(key.title, "Deep Residual Learning");
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

test("movePdfToHold: 同名ファイルが既に hold/ にあっても削除・上書きせず別名で退避する（消さない）", () => {
  const testDir = join(tmpdir(), `pp-hold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const inboxDir = join(testDir, "inbox");
  const holdDir = join(testDir, "hold");
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(holdDir, { recursive: true });

  // hold/ に既に存在するファイル
  const existingHoldFile = join(holdDir, "test-paper.pdf");
  writeFileSync(existingHoldFile, "first file in hold", "utf8");

  // inbox から新たに退避する同名ファイル
  const newInboxFile = join(inboxDir, "test-paper.pdf");
  writeFileSync(newInboxFile, "second file from inbox", "utf8");

  const dest = movePdfToHold(newInboxFile, holdDir);

  // 元の hold ファイルが消えていないこと
  assert.equal(readFileSync(existingHoldFile, "utf8"), "first file in hold");
  // 新しいファイルは (2).pdf として退避されること
  assert.equal(dest, join(holdDir, "test-paper (2).pdf"));
  assert.ok(existsSync(dest));
  assert.equal(readFileSync(dest, "utf8"), "second file from inbox");
  // inbox 側からは移動済みであること
  assert.equal(existsSync(newInboxFile), false);

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

test("filterDuplicateInboxPdfs: 作業中の論文（completed や eduShareTestId あり）を hold/ へ移さない", async () => {
  const testDir = join(tmpdir(), `pp-filter-inprogress-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const inboxDir = join(testDir, "inbox");
  const workDir = join(testDir, "work");
  const holdDir = join(testDir, "hold");
  const paperDir = join(workDir, "paper-in-progress");
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(paperDir, { recursive: true });

  const absPath = join(inboxDir, "paper-in-progress.pdf");
  writeFileSync(absPath, "in progress pdf", "utf8");
  // 既に作業中で completed に段階がある状態
  writeFileSync(
    join(paperDir, "state.json"),
    JSON.stringify({
      filename: "paper-in-progress.pdf",
      completed: ["sci-upload", "nlm-create"],
      eduShareTestId: "",
    }),
    "utf8",
  );

  const inboxItems = [
    { filename: "paper-in-progress.pdf", absPath, stem: "paper-in-progress", paperDir },
  ];

  // ターゲットに同じ論文（自身の work フォルダ）が含まれる
  const targets: MatchTarget[] = [
    {
      key: { arxivId: "2301.00001", title: "Paper In Progress", firstAuthor: "Author" },
      label: "work/paper-in-progress",
      path: paperDir,
    },
  ];

  const kept = await filterDuplicateInboxPdfs(inboxItems, targets, holdDir, {
    extractKey: async () => ({ arxivId: "2301.00001", title: "Paper In Progress", firstAuthor: "Author" }),
  });

  // 作業中なので hold/ に移されず、そのまま残る
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.filename, "paper-in-progress.pdf");
  assert.equal(existsSync(absPath), true);
  assert.equal(existsSync(join(holdDir, "paper-in-progress.pdf")), false);

  rmSync(testDir, { recursive: true, force: true });
});

test("filterDuplicateInboxPdfs: duplicates の親（残した正本）が自分の重複と一致して hold/ へ移されない", async () => {
  const testDir = join(tmpdir(), `pp-filter-parent-dup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const inboxDir = join(testDir, "inbox");
  const workDir = join(testDir, "work");
  const holdDir = join(testDir, "hold");
  const paperDir = join(workDir, "kept-paper");
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(paperDir, { recursive: true });

  const absPath = join(inboxDir, "kept-paper.pdf");
  writeFileSync(absPath, "kept paper pdf", "utf8");

  const inboxItems = [
    { filename: "kept-paper.pdf", absPath, stem: "kept-paper", paperDir },
  ];

  // ターゲットは kept-paper 配下の重複フォルダ (duplicates/kept-paper/dup-paper)
  const targets: MatchTarget[] = [
    {
      key: { arxivId: "physics/9905030", title: "Kept Paper", firstAuthor: "Schwarzschild" },
      label: "duplicates/kept-paper/dup-paper",
      path: "/path/to/dup-paper",
      keptPaper: "kept-paper", // 照合先は自分自身の重複
    },
  ];

  const kept = await filterDuplicateInboxPdfs(inboxItems, targets, holdDir, {
    extractKey: async () => ({ arxivId: "physics/9905030", title: "Kept Paper", firstAuthor: "Schwarzschild" }),
  });

  // 自分を正本とする duplicates と一致しても hold/ へ移されず、正本として処理される
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.filename, "kept-paper.pdf");
  assert.equal(existsSync(absPath), true);

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

test("filterDuplicateInboxPdfs: 同じ targets で複数回 filterDuplicateInboxPdfs を呼んでも自分自身と一致して退避されない", async () => {
  const testDir = join(tmpdir(), `pp-filter-rescan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const inboxDir = join(testDir, "inbox");
  const holdDir = join(testDir, "hold");
  mkdirSync(inboxDir, { recursive: true });

  const file = join(inboxDir, "pending-paper.pdf");
  writeFileSync(file, "content", "utf8");

  const inboxItems = [
    {
      filename: "pending-paper.pdf",
      absPath: file,
      stem: "pending-paper",
      paperDir: join(testDir, "work", "pending-paper"),
    },
  ];

  const targets: MatchTarget[] = [];
  const fakeKey = { arxivId: "2401.99999", title: "Pending Paper", firstAuthor: "Author" };

  // 1回目のスキャン
  const kept1 = await filterDuplicateInboxPdfs(inboxItems, targets, holdDir, {
    extractKey: async () => fakeKey,
  });
  assert.equal(kept1.length, 1);
  assert.equal(kept1[0]?.filename, "pending-paper.pdf");
  assert.equal(targets.length, 1);

  // 2回目の再スキャン (refreshInbox)
  const kept2 = await filterDuplicateInboxPdfs(inboxItems, targets, holdDir, {
    extractKey: async () => fakeKey,
  });
  assert.equal(kept2.length, 1);
  assert.equal(kept2[0]?.filename, "pending-paper.pdf");
  assert.equal(targets.length, 1, "ターゲット配列に重複追加されないこと");
  assert.equal(existsSync(file), true, "ファイルが hold へ移動されず残ること");

  rmSync(testDir, { recursive: true, force: true });
});
