import { existsSync } from "node:fs";
import { assertConfigPaths, loadConfig, parseArgv } from "./config.ts";
import { copyPdfsToInbox, listLibraryPdfs, pickUnprocessedPdfs, processedPdfNames } from "./fill-inbox.ts";
import { error as logError, log } from "./log.ts";

const DEFAULT_COUNT = 3;

function parseFillArgs(argv: string[]): { source: string; count: number; rest: string[] } {
  let source = "";
  let count = DEFAULT_COUNT;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--source") source = argv[++i] ?? "";
    else if (a === "--count") {
      const n = Number(argv[++i] ?? "");
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("--count には 1 以上の整数を指定してください");
      }
      count = n;
    } else if (a === "--help" || a === "-h") {
      rest.push(a);
    } else {
      rest.push(a);
    }
  }
  return { source, count, rest };
}

function help(): string {
  return `未処理の論文 PDF をライブラリから inbox へコピーする

使い方:
  npm run fill-inbox
  npm run fill-inbox -- --source "/path/to/papers"
  npm run fill-inbox -- --source "/path/to/papers" --count 3

inbox または作業フォルダに同じ PDF 名があるものは処理済みとして飛ばします。
変更日が古い順に --count 件（省略時は 3）を inbox 直下へコピーします。元のファイルは残します。
ソースは --source または PAPER_SOURCE_DIR。inbox と作業フォルダは .env の PAPER_INBOX_DIR / PAPER_WORK_DIR。
`;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(help());
    return;
  }
  const { source: sourceArg, count, rest } = parseFillArgs(argv);
  const cfg = loadConfig(parseArgv(rest));
  assertConfigPaths(cfg);
  const source = (sourceArg || process.env.PAPER_SOURCE_DIR || "").trim();
  if (!source) {
    throw new Error("PDF の置き場を --source または PAPER_SOURCE_DIR で指定してください");
  }
  if (!existsSync(source)) {
    throw new Error(`ソースディレクトリがありません: ${source}`);
  }
  const library = listLibraryPdfs(source);
  const processed = processedPdfNames(cfg.inboxDir, cfg.workDir);
  const picked = pickUnprocessedPdfs(library, processed, count);
  log(`ライブラリ ${library.length} 件中、未処理から ${picked.length} 件を inbox へコピーします`);
  const copied = copyPdfsToInbox(picked, cfg.inboxDir);
  for (const pdf of copied) {
    log(`inbox へ入れました: ${pdf.filename}`);
  }
  if (copied.length < count) {
    log(`未処理は ${copied.length} 件でした（指定 ${count} 件）`);
  }
}

try {
  main();
} catch (e) {
  logError(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
