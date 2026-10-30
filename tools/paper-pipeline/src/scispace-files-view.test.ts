import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILES_TAB_CLICK_GAP_MS,
  filesTabClickAllowed,
  looksLikeSciSpaceChatHome,
  looksLikeSciSpaceFilesTable,
  filesListNeedsLoadMore,
  isFilesListSearchHint,
  pageShowsPdfFilename,
  classifySciSpaceWaitState,
  formatSciSpaceWaitLog,
  SCISPACE_HEADLESS_FOLDER_TIMEOUT_MS,
  SCISPACE_HEADED_FOLDER_TIMEOUT_MS,
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

test("Files 検索は列設定とチャット欄を避ける", () => {
  assert.equal(isFilesListSearchHint("search Search files"), true);
  assert.equal(isFilesListSearchHint("text Search columns"), false);
  assert.equal(isFilesListSearchHint("text Give me any task on this folder composer"), false);
});

test("先頭 15 件と Load More がある一覧はページ送りが要る", () => {
  const partial = [
    "Upload PDFs",
    "Files (51)",
    "2601.18699v2.pdf",
    "Uploaded on 20 Sep 2026",
    "Showing 15 of 51 files",
    "Load More",
  ].join("\n");
  assert.equal(filesListNeedsLoadMore(partial), true);
  assert.equal(filesListNeedsLoadMore(filesTable), false);
});

test("改行と連続空白で割れた PDF 名も同じファイルとみなす", () => {
  const filename =
    "Geophysical Research Letters - 2022 - Cressie - From Many to One  Consensus Inference in a MIP.pdf";
  const shown = [
    "Geophysical Research Letters - 2022 - Cressie - From",
    "Many to One Consensus Inference in a MIP.pdf",
    "PDF UPLOAD Uploaded on 15 Oct 2026",
  ].join("\n");
  assert.equal(pageShowsPdfFilename(shown, filename), true);
  assert.equal(pageShowsPdfFilename("Files (122) Upload PDFs", filename), false);
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
test("サイドバーの Files 文言だけで表のないチャットを認識しない", () => {
  assert.equal(looksLikeSciSpaceFilesTable("Upload PDFs Files (4) Sort Notebooks (2) Uploaded on", false), false);
});

test("語中の改行も空白も除いて PDF 名を比較する", () => {
  assert.equal(pageShowsPdfFilename("phase2_3_\n0_1.pdf", "phase2_3_0_1.pdf"), true);
  assert.equal(pageShowsPdfFilename("phase2_3_0_1.pdf", "phase2_3_\n0_1.pdf"), true);
  assert.equal(pageShowsPdfFilename("another.pdf", "phase2_3_0_1.pdf"), false);
});

test("classifySciSpaceWaitState: ボット判定・ログイン画面・Files表・読み込み中を区別する", () => {
  assert.deepEqual(
    classifySciSpaceWaitState({ isBotChallenge: true }),
    { state: "bot_challenge", stateLabel: "ボット判定" },
  );
  assert.deepEqual(
    classifySciSpaceWaitState({ isLogin: true }),
    { state: "login", stateLabel: "ログイン画面" },
  );
  assert.deepEqual(
    classifySciSpaceWaitState({ hasTable: true, hasUploadBtn: true }),
    { state: "ready", stateLabel: "Files 表確認" },
  );
  assert.deepEqual(
    classifySciSpaceWaitState({ isReady: true }),
    { state: "ready", stateLabel: "Files 表確認" },
  );
  assert.deepEqual(
    classifySciSpaceWaitState({ hasFilesTab: true, hasTable: false, hasUploadBtn: false }),
    { state: "loading", stateLabel: "読み込み中" },
  );
});

test("formatSciSpaceWaitLog: 待機ログに残り時間・状態・URL・タイトル・主要要素を含める", () => {
  const logMsg = formatSciSpaceWaitLog({
    leftSeconds: 58,
    url: "https://scispace.com/folder/notebooks-enu289ww",
    title: "SciSpace - Folder",
    state: "loading",
    elements: { hasTable: false, hasFilesTab: true, hasUploadBtn: false },
  });
  assert.match(logMsg, /SciSpace 待ち（残り約 58s, 状態: 読み込み中）/);
  assert.match(logMsg, /url=https:\/\/scispace\.com\/folder\/notebooks-enu289ww/);
  assert.match(logMsg, /title="SciSpace - Folder"/);
  assert.match(logMsg, /要素=\[table:なし, filesTab:あり, uploadBtn:なし\]/);
});

test("タイムアウト定数: ヘッドレスは 60s、画面付きは 15 分", () => {
  assert.equal(SCISPACE_HEADLESS_FOLDER_TIMEOUT_MS, 60_000);
  assert.equal(SCISPACE_HEADED_FOLDER_TIMEOUT_MS, 15 * 60_000);
});

