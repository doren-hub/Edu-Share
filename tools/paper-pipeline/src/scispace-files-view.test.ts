import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILES_TAB_CLICK_GAP_MS,
  filesTabClickAllowed,
  looksLikeSciSpaceChatHome,
  looksLikeSciSpaceFilesTable,
} from "./scispace-files-view.ts";

const homeDump =
  "SCISPACE Toggle Sidebar New Chat Home Agent Gallery Templates Chat with PDF Literature Review View All Tools My Library Notebooks Untitled folder Untitled folder Recent Chats Short";

const filesTable = [
  "Upload PDFs",
  "Files (12)",
  "2307.03172v3.pdf",
  "TL;DR",
  "The paper discusses the proper form of Schwarzschild’s point mass field.",
  "Uploaded on 18 Sep 2026",
].join("\n");

const folderChromeOnly = "Upload PDFs Files (12) New Chat Home Agent Gallery Chat with PDF My Library Notebooks";

test("チャット/Home のサイドバーだけでは Files 表とみなさない", () => {
  assert.equal(looksLikeSciSpaceFilesTable(homeDump), false);
  assert.equal(looksLikeSciSpaceChatHome(homeDump), true);
});

test("Upload PDFs と Files (N) だけ（表なし）は Files 表ではない", () => {
  assert.equal(looksLikeSciSpaceFilesTable(folderChromeOnly), false);
  assert.equal(looksLikeSciSpaceChatHome(folderChromeOnly), true);
});

test("Uploaded on / TL;DR 列がある一覧は Files 表", () => {
  assert.equal(looksLikeSciSpaceFilesTable(filesTable), true);
  assert.equal(looksLikeSciSpaceChatHome(filesTable), false);
});

test("ファイル名検索 0 件でも Files 表（タブを押さない）", () => {
  const emptyFilter = [
    "Upload PDFs",
    "Files (42)",
    "Notebooks (3)",
    "Chats (0)",
    "Sort",
    'There are no results for "LineweaverPatel2023final"',
    "Try searching with a better keyword",
  ].join("\n");
  assert.equal(looksLikeSciSpaceFilesTable(emptyFilter), true);
  assert.equal(looksLikeSciSpaceChatHome(emptyFilter), false);
});

test("Files タブは選択済みや連打では押さない", () => {
  assert.equal(filesTabClickAllowed({ alreadySelected: true, lastClickAt: 0, now: 30_000 }), false);
  assert.equal(
    filesTabClickAllowed({ alreadySelected: false, lastClickAt: 10_000, now: 10_000 + FILES_TAB_CLICK_GAP_MS - 1 }),
    false,
  );
  assert.equal(
    filesTabClickAllowed({ alreadySelected: false, lastClickAt: 10_000, now: 10_000 + FILES_TAB_CLICK_GAP_MS }),
    true,
  );
});