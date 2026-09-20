import { existsSync } from "node:fs";
import { PACKAGE_ROOT, loadDotEnv, resolvePathMaybe } from "./env.ts";
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
    }
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
    headed: overrides.headed !== false,
    onlyFilename: (overrides.onlyFilename ?? "").trim(),
    fromStage,
    skipSlidesVideo,
    studioGenerate,
    studioSkip,
    studioGenerateExplicit,
  };
}

export function helpText(): string {
  return `論文アップロード外部自動化ツール

使い方:
  npm start
  npm start -- --inbox /path/pdfs --work /path/work
  npm start -- --only paper.pdf --from sci-meta
  npm start -- --generate quiz,flashcards
  npm start -- --only paper.pdf --generate slides,video
  npm run worker -- --only paper.pdf

npm start は呼び出し側です。1論文ずつ既存 worker を呼びます。--generate で slides / video / quiz / flashcards を選べます（複数可、all で全部）。指定した項目が生成待ちか完了になるまで次の論文の生成には進みません。Edu Share 済みの論文にも、足りない項目を後から生成できます。同じプロファイルで Chrome を同時には開きません。

必須: PAPER_INBOX_DIR と PAPER_WORK_DIR（.env または引数）

オプション:
  --inbox DIR          未処理 PDF のディレクトリ
  --work DIR           作業ディレクトリ（論文ごとのフォルダを作る）
  --only FILE.pdf      そのファイルだけ処理
  --from STAGE         その段階から再開（--only と併用、初回の worker のみ）
  --generate ITEMS     生成するもの。カンマ区切りまたは繰り返し。all で全部
                       slides / video / quiz / flashcards
  --stop-on-error      1件失敗で終了
  --headed / --headless
  --skip-slides-video  --generate quiz,flashcards と同じ（互換）
`;
}

export function assertConfigPaths(cfg: AppConfig): void {
  if (!existsSync(cfg.inboxDir)) {
    throw new Error(`入力ディレクトリがありません: ${cfg.inboxDir}`);
  }
}
