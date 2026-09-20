import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInboxPdfs, listVideoRepairPdfs, mergeInboxAndVideoRepair } from "./inbox.ts";

test("listInboxPdfs: 変更日が古い順（名前順ではない）", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-inbox-"));
  const inbox = join(root, "inbox");
  const work = join(root, "work");
  mkdirSync(inbox);
  mkdirSync(work);
  try {
    const older = join(inbox, "z-old.pdf");
    const newer = join(inbox, "a-new.pdf");
    writeFileSync(older, "old");
    writeFileSync(newer, "new");
    const now = Date.now() / 1000;
    utimesSync(older, now - 120, now - 120);
    utimesSync(newer, now - 10, now - 10);
    assert.deepEqual(
      listInboxPdfs(inbox, work).map((p) => p.filename),
      ["z-old.pdf", "a-new.pdf"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listVideoRepairPdfs: MP4 が無い完了論文だけ", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-repair-"));
  const work = join(root, "work");
  const paperDir = join(work, "0709.2257v2");
  mkdirSync(paperDir, { recursive: true });
  mkdirSync(join(root, "empty-inbox"));
  try {
    writeFileSync(join(paperDir, "0709.2257v2.pdf"), "pdf");
    writeFileSync(
      join(paperDir, "state.json"),
      JSON.stringify({
        filename: "0709.2257v2.pdf",
        inboxPdfPath: join(paperDir, "0709.2257v2.pdf"),
        paperDir,
        completed: ["nlm-video", "done"],
        notebooklmUrl: "https://notebook.google.com/notebook/abcd",
        videoMp4Path: "",
      }),
    );
    const found = listVideoRepairPdfs(work);
    assert.deepEqual(
      found.map((p) => p.filename),
      ["0709.2257v2.pdf"],
    );
    const inbox = listInboxPdfs(join(root, "empty-inbox"), work);
    assert.deepEqual(mergeInboxAndVideoRepair(inbox, found).map((p) => p.filename), [
      "0709.2257v2.pdf",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
