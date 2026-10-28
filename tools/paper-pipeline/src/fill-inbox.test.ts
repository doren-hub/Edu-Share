import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyPdfsToInbox,
  finderMtimeMs,
  listDuplicatePdfNames,
  listLibraryPdfs,
  parseFinderLibraryListing,
  pickUnprocessedPdfs,
  processedPdfNames,
} from "./fill-inbox.ts";

test("parseFinderLibraryListing: PDF の変更日とサブディレクトリを読む", () => {
  const parsed = parseFinderLibraryListing(
    [
      "PDF\told.pdf\t/lib/old.pdf\t2026-9-14 100",
      "DIR\t/lib/nested",
      "PDF\tnew.pdf\t/lib/new.pdf\t2026-9-17 200",
    ].join("\n"),
  );
  assert.deepEqual(parsed.dirs, ["/lib/nested"]);
  assert.equal(parsed.pdfs[0]?.filename, "old.pdf");
  assert.equal(parsed.pdfs[0]?.mtimeMs, finderMtimeMs(2026, 9, 14, 100));
  assert.ok((parsed.pdfs[1]?.mtimeMs ?? 0) > (parsed.pdfs[0]?.mtimeMs ?? 0));
});

test("pickUnprocessedPdfs: 処理済みと重複名を飛ばし、古い順に件数だけ取る", () => {
  const source = [
    { filename: "new.pdf", absPath: "/lib/new.pdf", mtimeMs: 30 },
    { filename: "done.pdf", absPath: "/lib/a/done.pdf", mtimeMs: 10 },
    { filename: "old.pdf", absPath: "/lib/old.pdf", mtimeMs: 5 },
    { filename: "Old.pdf", absPath: "/lib/b/Old.pdf", mtimeMs: 1 },
    { filename: "mid.pdf", absPath: "/lib/mid.pdf", mtimeMs: 20 },
  ];
  const picked = pickUnprocessedPdfs(source, new Set(["done.pdf"]), 2);
  assert.deepEqual(
    picked.map((p) => p.filename),
    ["old.pdf", "mid.pdf"],
  );
});

test("fill-inbox: ライブラリの未処理 3 件を inbox にコピーし、元は残す", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-fill-"));
  const library = join(root, "library", "nested");
  const inbox = join(root, "inbox");
  const work = join(root, "work", "already");
  mkdirSync(library, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  mkdirSync(work, { recursive: true });
  try {
    writeFileSync(join(library, "already.pdf"), "already");
    writeFileSync(join(work, "already.pdf"), "already");
    writeFileSync(
      join(work, "state.json"),
      JSON.stringify({ filename: "already.pdf", inboxPdfPath: join(work, "already.pdf"), paperDir: work }),
    );
    const names = ["c.pdf", "a.pdf", "b.pdf", "d.pdf"];
    for (const name of names) writeFileSync(join(library, name), name);
    const now = Date.now() / 1000;
    utimesSync(join(library, "c.pdf"), now - 40, now - 40);
    utimesSync(join(library, "a.pdf"), now - 30, now - 30);
    utimesSync(join(library, "b.pdf"), now - 20, now - 20);
    utimesSync(join(library, "d.pdf"), now - 10, now - 10);
    utimesSync(join(library, "already.pdf"), now - 50, now - 50);

    const found = listLibraryPdfs(join(root, "library"));
    assert.equal(found.length, 5);
    const picked = pickUnprocessedPdfs(found, processedPdfNames(inbox, join(root, "work")), 3);
    const copied = copyPdfsToInbox(picked, inbox);
    assert.deepEqual(
      copied.map((p) => p.filename),
      ["c.pdf", "a.pdf", "b.pdf"],
    );
    assert.equal(readFileSync(join(inbox, "c.pdf"), "utf8"), "c.pdf");
    assert.equal(readFileSync(join(library, "c.pdf"), "utf8"), "c.pdf");
    assert.equal(copied.find((p) => p.filename === "d.pdf"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listDuplicatePdfNames: duplicates/*/*/state.json の filename、無ければフォルダ名を読む", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-dup-"));
  try {
    const dupRoot = join(root, "duplicates");
    // 存在しない場合は空 Set
    assert.equal(listDuplicatePdfNames(dupRoot).size, 0);

    // 正常構造: duplicates/<残した論文>/<重複>
    const keptDir = join(dupRoot, "kept-paper-1");
    const dupWithState = join(keptDir, "dup-1");
    const dupWithoutState = join(keptDir, "5270");
    const dupEmptyState = join(keptDir, "dup-empty");
    const dupBrokenState = join(keptDir, "dup-broken");
    const hiddenDir = join(dupRoot, ".DS_Store");
    mkdirSync(dupWithState, { recursive: true });
    mkdirSync(dupWithoutState, { recursive: true });
    mkdirSync(dupEmptyState, { recursive: true });
    mkdirSync(dupBrokenState, { recursive: true });
    mkdirSync(hiddenDir, { recursive: true });

    writeFileSync(join(dupWithState, "state.json"), JSON.stringify({ filename: "1310.6541v1.pdf" }));
    writeFileSync(join(dupEmptyState, "state.json"), JSON.stringify({ filename: "  " }));
    writeFileSync(join(dupBrokenState, "state.json"), "invalid json");

    const names = listDuplicatePdfNames(dupRoot);
    assert.ok(names.has("1310.6541v1.pdf"));
    // state.json が無ければフォルダ名（拡張子なしは .pdf が補完される）
    assert.ok(names.has("5270.pdf"));
    // state.json の filename が空ならフォルダ名
    assert.ok(names.has("dup-empty.pdf"));
    // state.json が壊れていればフォルダ名
    assert.ok(names.has("dup-broken.pdf"));
    assert.equal(names.size, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fill-inbox: duplicates 配下の論文（work の兄弟ディレクトリ）を処理済みとしてスキップする", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-fill-dup-"));
  const library = join(root, "library");
  const inbox = join(root, "inbox");
  const work = join(root, "work");
  const duplicates = join(root, "duplicates");
  const keptDir = join(duplicates, "kept-paper");
  const dup1 = join(keptDir, "dup-with-state");
  const dup2 = join(keptDir, "dup-no-state");

  mkdirSync(library, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(dup1, { recursive: true });
  mkdirSync(dup2, { recursive: true });

  try {
    // dup1 には state.json で filename 指定
    writeFileSync(join(dup1, "state.json"), JSON.stringify({ filename: "dup-from-state.pdf" }));
    // dup2 には state.json なし（フォルダ名 dup-no-state が PDF 名になる）

    // ライブラリに重複と未処理 PDF を配置
    writeFileSync(join(library, "dup-from-state.pdf"), "content");
    writeFileSync(join(library, "dup-no-state.pdf"), "content");
    writeFileSync(join(library, "fresh-paper.pdf"), "content");

    const found = listLibraryPdfs(library);
    assert.equal(found.length, 3);

    // duplicatesDir を省略しても work の兄弟ディレクトリ duplicates/ を見る
    const processed = processedPdfNames(inbox, work);
    assert.ok(processed.has("dup-from-state.pdf"));
    assert.ok(processed.has("dup-no-state.pdf"));
    assert.ok(!processed.has("fresh-paper.pdf"));

    const picked = pickUnprocessedPdfs(found, processed, 3);
    assert.deepEqual(
      picked.map((p) => p.filename),
      ["fresh-paper.pdf"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
