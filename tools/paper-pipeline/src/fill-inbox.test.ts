import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_PERMISSION_ERROR,
  FillInboxPermissionError,
  copyPdfsToInbox,
  finderMtimeMs,
  formatPermissionErrorMessage,
  isPermissionError,
  listDuplicatePdfNames,
  listLibraryPdfs,
  parseFinderLibraryListing,
  pickUnprocessedPdfs,
  processedPdfNames,
} from "./fill-inbox.ts";
import { runFillInboxCli } from "./fill-inbox-cli.ts";

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

test("isPermissionError: EPERM, EACCES, -1743, Apple Events, FillInboxPermissionError を正しく検出し通常エラーは false", () => {
  assert.equal(isPermissionError(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })), true);
  assert.equal(isPermissionError(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })), true);
  assert.equal(
    isPermissionError({
      message: "Command failed: osascript -e ...",
      stderr: "execution error: FinderにApple Eventsを送信する権限がありません。 (-1743)",
    }),
    true,
  );
  assert.equal(
    isPermissionError({
      message: "Not authorized to send Apple events to Finder. (-1743)",
      stderr: "",
    }),
    true,
  );
  assert.equal(isPermissionError(new FillInboxPermissionError("test")), true);

  // 通常エラー
  assert.equal(isPermissionError(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })), false);
  assert.equal(isPermissionError(new Error("Generic failure")), false);
  assert.equal(isPermissionError(null), false);
  assert.equal(isPermissionError(undefined), false);
});

test("formatPermissionErrorMessage: 原因と対処の 2 行構成で AppleScript コードを含まない", () => {
  const msg = formatPermissionErrorMessage("/sample/papers");
  const lines = msg.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes("EPERM / -1743"));
  assert.ok(lines[0]!.includes("/sample/papers"));
  assert.ok(lines[1]!.includes("PAPER_SOURCE_DIR"));
  assert.ok(!msg.includes("tell application"));
  assert.ok(!msg.includes("osascript"));
});

test("listLibraryPdfs: EPERM と -1743 のとき専用の FillInboxPermissionError と短いメッセージになる (Finder/実ファイル不使用)", () => {
  const epermError = Object.assign(new Error("operation not permitted, scandir '/protected'"), { code: "EPERM" });
  const appleEventsError = Object.assign(
    new Error("Command failed: osascript -e on run argv tell application Finder end run"),
    {
      stderr: "execution error: FinderにApple Eventsを送信する権限がありません。 (-1743)",
    },
  );

  let finderCalled = false;
  assert.throws(
    () => {
      listLibraryPdfs("/protected", {
        platform: "darwin",
        readdir: () => {
          throw epermError;
        },
        execFinder: () => {
          finderCalled = true;
          throw appleEventsError;
        },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof FillInboxPermissionError);
      // AppleScript 本文が含まれていないこと
      assert.ok(!err.message.includes("tell application"));
      assert.ok(!err.message.includes("on run argv"));
      // 原因と対処の 2 行で EPERM / -1743 を含むこと
      const lines = err.message.split("\n");
      assert.equal(lines.length, 2);
      assert.ok(err.message.includes("EPERM / -1743"));
      assert.ok(err.message.includes("PAPER_SOURCE_DIR"));
      return true;
    },
  );
  assert.ok(finderCalled, "readdir が EPERM の際に Finder 経由が試みられること");
});

test("listLibraryPdfs: Linux 等の非 darwin 環境で EPERM のときは Finder を呼ばず直接 FillInboxPermissionError を投げる", () => {
  const epermError = Object.assign(new Error("operation not permitted, scandir '/protected'"), { code: "EPERM" });
  let finderCalled = false;
  assert.throws(
    () => {
      listLibraryPdfs("/protected", {
        platform: "linux",
        readdir: () => {
          throw epermError;
        },
        execFinder: () => {
          finderCalled = true;
          return "";
        },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof FillInboxPermissionError);
      assert.ok(err.message.includes("EPERM / -1743"));
      return true;
    },
  );
  assert.equal(finderCalled, false, "非 darwin 環境では Finder を呼ばないこと");
});

test("copyPdfsToInbox: copyFileSync が EPERM で Finder が -1743 のとき FillInboxPermissionError を投げる", () => {
  const epermError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const appleEventsError = Object.assign(new Error("Command failed"), {
    stderr: "execution error: FinderにApple Eventsを送信する権限がありません。 (-1743)",
  });

  const pdfs = [{ filename: "test.pdf", absPath: "/lib/test.pdf", mtimeMs: 100 }];
  assert.throws(
    () => {
      copyPdfsToInbox(pdfs, "/inbox", {
        platform: "darwin",
        copyFile: () => {
          throw epermError;
        },
        execFinder: () => {
          throw appleEventsError;
        },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof FillInboxPermissionError);
      assert.ok(!err.message.includes("FINDER_COPY_SCRIPT"));
      assert.ok(err.message.includes("EPERM / -1743"));
      return true;
    },
  );
});

test("runFillInboxCli: EPERM と -1743 で終了コード 17 と 1〜2 行のエラーログを出力する", () => {
  const root = mkdtempSync(join(tmpdir(), "fill-inbox-cli-test-"));
  const inbox = join(root, "inbox");
  const work = join(root, "work");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(work, { recursive: true });

  const loggedErrors: string[] = [];
  const loggedOutputs: string[] = [];

  const epermError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  const appleEventsError = Object.assign(new Error("Command failed: osascript -e on run argv ..."), {
    stderr: "execution error: FinderにApple Eventsを送信する権限がありません。 (-1743)",
  });

  try {
    const code = runFillInboxCli(
      ["--source", "/mock/library", "--inbox", inbox, "--work", work],
      {
        platform: "darwin",
        stat: () => ({ mtimeMs: 100 }),
        readdir: () => {
          throw epermError;
        },
        execFinder: () => {
          throw appleEventsError;
        },
      },
      {
        logFn: (msg) => loggedOutputs.push(msg),
        errorFn: (msg) => loggedErrors.push(msg),
      },
    );

    assert.equal(code, EXIT_PERMISSION_ERROR);
    assert.equal(EXIT_PERMISSION_ERROR, 17);
    assert.equal(loggedErrors.length, 1);
    const errMsg = loggedErrors[0]!;
    const lines = errMsg.split("\n");
    assert.equal(lines.length, 2);
    assert.ok(errMsg.includes("EPERM / -1743"));
    assert.ok(errMsg.includes("PAPER_SOURCE_DIR"));
    // AppleScript の全文はログに出さない
    assert.ok(!errMsg.includes("on run argv"));
    assert.ok(!errMsg.includes("osascript"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runFillInboxCli: statSync が EPERM の場合も終了コード 17 で安全に処理する", () => {
  const root = mkdtempSync(join(tmpdir(), "fill-inbox-cli-test-"));
  const inbox = join(root, "inbox");
  const work = join(root, "work");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(work, { recursive: true });

  const loggedErrors: string[] = [];
  const epermError = Object.assign(new Error("operation not permitted, stat '/protected'"), { code: "EPERM" });

  try {
    const code = runFillInboxCli(
      ["--source", "/protected", "--inbox", inbox, "--work", work],
      {
        stat: (p: string) => {
          if (p === "/protected") throw epermError;
          return { mtimeMs: 100 };
        },
      },
      {
        errorFn: (msg) => loggedErrors.push(msg),
      },
    );

    assert.equal(code, 17);
    assert.equal(loggedErrors.length, 1);
    assert.ok(loggedErrors[0]!.includes("EPERM / -1743"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runFillInboxCli: 設定（--source および PAPER_SOURCE_DIR）で補充元を変更できる", () => {
  const root = mkdtempSync(join(tmpdir(), "fill-inbox-cli-test-"));
  const inbox = join(root, "inbox");
  const work = join(root, "work");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(work, { recursive: true });

  let accessedDir = "";
  const loggedOutputs: string[] = [];

  const deps = {
    stat: () => ({ mtimeMs: 100 }),
    readdir: (dir: string) => {
      accessedDir = dir;
      return [];
    },
  };

  try {
    // 1. --source オプションによる指定
    const code1 = runFillInboxCli(
      ["--source", "/custom/source/dir", "--inbox", inbox, "--work", work],
      deps,
      { logFn: (msg) => loggedOutputs.push(msg) },
    );
    assert.equal(code1, 0);
    assert.equal(accessedDir, "/custom/source/dir");

    // 2. PAPER_SOURCE_DIR 環境変数による指定
    const code2 = runFillInboxCli(
      ["--inbox", inbox, "--work", work],
      deps,
      {
        env: { PAPER_SOURCE_DIR: "/env/source/dir" },
        logFn: (msg) => loggedOutputs.push(msg),
      },
    );
    assert.equal(code2, 0);
    assert.equal(accessedDir, "/env/source/dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
