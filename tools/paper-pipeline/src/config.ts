import { existsSync } from "node:fs";
import { PACKAGE_ROOT, loadDotEnv, resolvePathMaybe } from "./env.ts";
import {
  DEFAULT_SHORT_STOP_PERCENT,
  DEFAULT_WEEKLY_STOP_PERCENT,
  defaultNotebookQuotaFiles,
  defaultNotebookQuotaUrls,
} from "./notebook-quota.ts";
import { isStageId, type StageId, type StudioStageId } from "./state.ts";
import {
  parseStudioGenerateTokens,
  skipStudioStages,
  splitGenerateArg,
} from "./studio-select.ts";

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
  skipSlidesVideo: boolean;
  /** 今回生成する Studio 項目。省略時は 4 種すべて */
  studioGenerate: StudioStageId[];
  studioSkip: readonly StudioStageId[];
  studioGenerateExplicit: boolean;
  ignoreNotebookQuota: boolean;
  newestFirst: boolean;
  notebookQuotaUrls: readonly string[];
  notebookQuotaFiles: readonly string[];
  notebookShortStopPercent: number;
  notebookWeeklyStopPercent: number;
};

export type CliOverrides = {
  inbox?: string;
  work?: string;
  stopOnError?: boolean;
  headed?: boolean;
  onlyFilename?: string;
  fromStage?: string;
  skipSlidesVideo?: boolean;
  generate?: string[];
  ignoreNotebookQuota?: boolean;
  newestFirst?: boolean;
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
    else if (a === "--skip-slides-video") out.skipSlidesVideo = true;
    else if (a === "--generate") {
      const tokens = splitGenerateArg(next());
      if (tokens.length === 0) {
        throw new Error("--generate には slides / video / quiz / flashcards / all を指定してください");
      }
      out.generate = [...(out.generate ?? []), ...tokens];
    } else if (a === "--ignore-notebook-quota") out.ignoreNotebookQuota = true;
    else if (a === "--newest-first") out.newestFirst = true;
  }
  return out;
}

export function envFlagEnabled(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** 引数 --headless / --headed が環境変数 HEADLESS より優先。未指定なら画面付き。 */
export function resolveHeaded(
  overrides: Pick<CliOverrides, "headed">,
  headlessEnv: string | undefined = process.env.HEADLESS,
): boolean {
  if (overrides.headed !== undefined) return overrides.headed;
  return !envFlagEnabled(headlessEnv);
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
  const envGenerate = (process.env.STUDIO_GENERATE ?? process.env.GENERATE ?? "").trim();
  const skipSlidesVideoFlag =
    overrides.skipSlidesVideo === true ||
    process.env.SKIP_SLIDES_VIDEO === "1" ||
    process.env.SKIP_SLIDES_VIDEO === "true";
  const generateTokens = [
    ...(overrides.generate ?? []),
    ...splitGenerateArg(envGenerate),
  ];
  const studioGenerateExplicit =
    generateTokens.length > 0 || skipSlidesVideoFlag;
  const studioGenerate = parseStudioGenerateTokens(
    generateTokens.length > 0
      ? generateTokens
      : skipSlidesVideoFlag
        ? ["quiz", "flashcards"]
        : [],
  );
  const studioSkip = skipStudioStages(studioGenerate);
  const skipSlidesVideo =
    studioSkip.includes("nlm-slides") && studioSkip.includes("nlm-video");
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
    headed: resolveHeaded(overrides),
    onlyFilename: (overrides.onlyFilename ?? "").trim(),
    fromStage,
    skipSlidesVideo,
    studioGenerate,
    studioSkip,
    studioGenerateExplicit,
    ignoreNotebookQuota:
      overrides.ignoreNotebookQuota === true ||
      process.env.IGNORE_NOTEBOOK_QUOTA === "1" ||
      process.env.IGNORE_NOTEBOOK_QUOTA === "true",
    newestFirst:
      overrides.newestFirst === true ||
      process.env.NEWEST_FIRST === "1" ||
      process.env.NEWEST_FIRST === "true",
    notebookQuotaUrls: defaultNotebookQuotaUrls(),
    notebookQuotaFiles: defaultNotebookQuotaFiles(),
    notebookShortStopPercent: envPercent(
      "NOTEBOOK_SHORT_STOP_PERCENT",
      DEFAULT_SHORT_STOP_PERCENT,
    ),
    notebookWeeklyStopPercent: envPercent(
      "NOTEBOOK_WEEKLY_STOP_PERCENT",
      DEFAULT_WEEKLY_STOP_PERCENT,
    ),
  };
}

function envPercent(key: string, fallback: number): number {
  const raw = (process.env[key] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function helpText(): string {
  return `論文アップロード外部自動化ツール

使い方:
  npm start
  npm start -- --inbox /path/pdfs --work /path/work
  npm start -- --only paper.pdf --from sci-meta
  npm start -- --generate quiz,flashcards
  npm start -- --headless
  npm run repair-meta
  npm run repair-meta -- --only paper.pdf --headed
  npm run fill-inbox -- --source "/path/to/papers" --count 3
  npm run worker -- --only paper.pdf --headless

npm start は inbox 直下の PDF だけを、1論文ずつ worker で処理します。作業フォルダにあるだけの論文は対象にしません。SciSpace のメタ補修（Files 行が空、省略著者、画面文言の題名や掲載）は npm run repair-meta です。未処理 PDF をライブラリから inbox へ 3 件コピーするのは npm run fill-inbox です。npm start と同時には起動しません。--generate で slides / video / quiz / flashcards を選べます（複数可、all で全部）。指定した項目が生成待ちか完了になるまで次の論文の生成には進みません。同じプロファイルで Chrome を同時には開きません。Notebook の短期枠が 85% を超えているあいだは生成を止め、週枠が 100% ならリセット時刻まで待ちます。そのあいだは、処理中の inbox の論文について SciSpace と、できている生成物の Edu Share 登録を先に進めます。

必須: PAPER_INBOX_DIR と PAPER_WORK_DIR（.env または引数）

オプション:
  --inbox DIR          未処理 PDF のディレクトリ
  --work DIR           作業ディレクトリ（論文ごとのフォルダを作る）
  --only FILE.pdf      そのファイルだけ処理
  --from STAGE         その段階から再開（--only と併用、初回の worker のみ）
  --generate ITEMS     生成するもの。カンマ区切りまたは繰り返し。all で全部
                       slides / video / quiz / flashcards
  --stop-on-error      1件失敗で終了
  --headed             画面付きで Chrome を開く（既定）。デバッグ用
  --headless           ウィンドウを出さずに実行。ログインや追加確認のときだけ画面を出す
                       環境変数 HEADLESS=1 でも可。引数が優先
  --skip-slides-video  --generate quiz,flashcards と同じ（互換）
  --newest-first       新しい論文（変更日が新しい PDF）から処理
  --ignore-notebook-quota  Notebook 利用量による停止をしない
`;
}

export function assertConfigPaths(cfg: AppConfig): void {
  if (!existsSync(cfg.inboxDir)) {
    throw new Error(`入力ディレクトリがありません: ${cfg.inboxDir}`);
  }
}
