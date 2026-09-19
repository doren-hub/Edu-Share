import { existsSync } from "node:fs";
import { PACKAGE_ROOT, loadDotEnv, resolvePathMaybe } from "./env.ts";
import { isStageId, type StageId } from "./state.ts";

export type AppConfig = {
  inboxDir: string;
  workDir: string;
  eduShareBaseUrl: string;
  scispaceFolderUrl: string;
  notebooklmUrl: string;
  exportExtensionPath: string;
  chromeUserDataDir: string;
  eduShareEmail: string;
  eduSharePassword: string;
  stopOnError: boolean;
  headed: boolean;
  onlyFilename: string;
  fromStage: StageId | null;
};

export type CliOverrides = {
  inbox?: string;
  work?: string;
  stopOnError?: boolean;
  headed?: boolean;
  onlyFilename?: string;
  fromStage?: string;
};

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export function parseArgv(argv: string[]): CliOverrides {
  const out: CliOverrides = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (a === "--inbox") out.inbox = next();
    else if (a === "--work") out.work = next();
    else if (a === "--only") out.onlyFilename = next();
    else if (a === "--from") out.fromStage = next();
    else if (a === "--stop-on-error") out.stopOnError = true;
    else if (a === "--headless") out.headed = false;
    else if (a === "--headed") out.headed = true;
  }
  return out;
}

export function loadConfig(overrides: CliOverrides): AppConfig {
  loadDotEnv(`${PACKAGE_ROOT}/.env`);
  const cwd = process.cwd();
  const inbox = overrides.inbox || process.env.PAPER_INBOX_DIR || "";
  const work = overrides.work || process.env.PAPER_WORK_DIR || "";
  if (!inbox.trim() || !work.trim()) {
    throw new Error(
      "PAPER_INBOX_DIR と PAPER_WORK_DIR を .env か --inbox / --work で指定してください。",
    );
  }
  let fromStage: StageId | null = null;
  if (overrides.fromStage) {
    if (!isStageId(overrides.fromStage)) {
      throw new Error(`不明な --from: ${overrides.fromStage}`);
    }
    fromStage = overrides.fromStage;
  }
  const ext = (process.env.NOTEBOOKLM_EXPORT_EXTENSION_PATH ?? "").trim();
  return {
    inboxDir: resolvePathMaybe(inbox.trim(), cwd),
    workDir: resolvePathMaybe(work.trim(), cwd),
    eduShareBaseUrl: stripTrailingSlash(
      (process.env.EDU_SHARE_BASE_URL ?? "http://localhost:3000").trim(),
    ),
    scispaceFolderUrl: (
      process.env.SCISPACE_FOLDER_URL ??
      "https://scispace.com/folder/notebooks-enu289ww"
    ).trim(),
    notebooklmUrl: (process.env.NOTEBOOKLM_URL ?? "https://notebooklm.google.com/").trim(),
    exportExtensionPath: ext ? resolvePathMaybe(ext, cwd) : "",
    chromeUserDataDir: resolvePathMaybe(
      (process.env.CHROME_USER_DATA_DIR ?? ".chrome-profile").trim(),
      PACKAGE_ROOT,
    ),
    eduShareEmail: (process.env.EDU_SHARE_EMAIL ?? "").trim(),
    eduSharePassword: (process.env.EDU_SHARE_PASSWORD ?? "").trim(),
    stopOnError:
      overrides.stopOnError === true ||
      process.env.STOP_ON_ERROR === "1" ||
      process.env.STOP_ON_ERROR === "true",
    headed: overrides.headed !== false,
    onlyFilename: (overrides.onlyFilename ?? "").trim(),
    fromStage,
  };
}

export function helpText(): string {
  return `論文アップロード外部自動化ツール

使い方:
  npm start
  npm start -- --inbox /path/pdfs --work /path/work
  npm start -- --only paper.pdf --from sci-upload

必須: PAPER_INBOX_DIR と PAPER_WORK_DIR（.env または引数）

オプション:
  --inbox DIR          未処理 PDF のディレクトリ
  --work DIR           作業ディレクトリ（論文ごとのフォルダを作る）
  --only FILE.pdf      そのファイルだけ処理
  --from STAGE         その段階から再開（--only と併用）
  --stop-on-error      1件失敗で終了
  --headed / --headless
`;
}

export function assertConfigPaths(cfg: AppConfig): void {
  if (!existsSync(cfg.inboxDir)) {
    throw new Error(`入力ディレクトリがありません: ${cfg.inboxDir}`);
  }
}
