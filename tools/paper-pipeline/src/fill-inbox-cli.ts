import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertConfigPaths, loadConfig, parseArgv } from "./config.ts";
import { PACKAGE_ROOT, resolvePathMaybe } from "./env.ts";
import {
  EXIT_PERMISSION_ERROR,
  type FillInboxDeps,
  fillInbox,
  formatPermissionErrorMessage,
  isPermissionError,
} from "./fill-inbox.ts";
import { error as logError, log } from "./log.ts";

const DEFAULT_COUNT = 3;

export function parseFillArgs(argv: string[]): { source: string; count: number; rest: string[] } {
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

export function help(): string {
  return `未処理の論文 PDF をライブラリから inbox へコピーする

使い方:
  npm run fill-inbox
  npm run fill-inbox -- --source "/path/to/papers"
  npm run fill-inbox -- --source "/path/to/papers" --count 3

inbox、作業フォルダ、または duplicates 配下に同じ PDF 名があるものは処理済みとして飛ばします。
変更日が古い順に --count 件（省略時は 3）を inbox 直下へコピーします。元のファイルは残します。
ソースは --source または環境変数 PAPER_SOURCE_DIR（.env も可）。inbox と作業フォルダは .env の PAPER_INBOX_DIR / PAPER_WORK_DIR。
macOS の権限不足（EPERM、-1743）で補充元を読めない場合は終了コード 17 で終了します。
`;
}

export function runFillInboxCli(
  argv: string[],
  deps: FillInboxDeps = {},
  options?: {
    env?: Record<string, string | undefined>;
    logFn?: (msg: string) => void;
    errorFn?: (msg: string) => void;
  },
): number {
  const logMessage = options?.logFn ?? log;
  const logErrorMessage = options?.errorFn ?? logError;
  const env = options?.env ?? process.env;

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(help());
    return 0;
  }
  const { source: sourceArg, count, rest } = parseFillArgs(argv);
  const cfg = loadConfig(parseArgv(rest));
  assertConfigPaths(cfg);
  const rawSource = (sourceArg || env.PAPER_SOURCE_DIR || "").trim();
  if (!rawSource) {
    throw new Error("PDF の置き場を --source または PAPER_SOURCE_DIR で指定してください");
  }
  const source = resolvePathMaybe(rawSource, PACKAGE_ROOT);

  // existsSync が EPERM の際に false を返す場合があるため、statSync で存在と権限を確認
  const statFn = deps.stat ?? statSync;
  try {
    statFn(source);
  } catch (e) {
    if (isPermissionError(e)) {
      logErrorMessage(formatPermissionErrorMessage(source));
      return EXIT_PERMISSION_ERROR;
    }
    throw new Error(`ソースディレクトリがありません: ${source}`);
  }

  try {
    const { libraryCount, pickedCount, copied } = fillInbox(
      {
        source,
        count,
        inboxDir: cfg.inboxDir,
        workDir: cfg.workDir,
        duplicatesDir: cfg.duplicatesDir,
        holdDir: cfg.holdDir,
      },
      deps,
    );
    logMessage(`ライブラリ ${libraryCount} 件中、未処理から ${pickedCount} 件を inbox へコピーします`);
    for (const pdf of copied) {
      logMessage(`inbox へ入れました: ${pdf.filename}`);
    }
    if (copied.length < count) {
      logMessage(`未処理は ${copied.length} 件でした（指定 ${count} 件）`);
    }
    return 0;
  } catch (e) {
    if (isPermissionError(e)) {
      logErrorMessage(e instanceof Error ? e.message : formatPermissionErrorMessage(source));
      return EXIT_PERMISSION_ERROR;
    }
    throw e;
  }
}

export function isMainModule(
  metaUrl: string = import.meta.url,
  scriptPath: string | null = process.argv[1] ?? null,
): boolean {
  if (!scriptPath) return false;
  try {
    return realpathSync(scriptPath) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  try {
    const exitCode = runFillInboxCli(argv);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (e) {
    logError(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

if (isMainModule()) {
  main();
}
