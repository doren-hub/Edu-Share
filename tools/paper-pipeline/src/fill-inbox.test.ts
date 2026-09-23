import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyPdfsToInbox,
  finderMtimeMs,
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
