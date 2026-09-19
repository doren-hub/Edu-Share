import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { AppConfig } from "./config.ts";
import { assertPageAlive } from "./browser.ts";
import {
  ensurePaperDir,
  hasDoneMarker,
  moveInboxPdfToPaperDir,
  writeDoneMarker,
  type InboxPdf,
} from "./inbox.ts";
import { error as logError, firstLine, log, warn } from "./log.ts";
import { matchesExistingPaper, titlesLikelySame, titleUsableForExistingMatch, type ExistingPaper } from "./match.ts";
import { isSciSpaceRecordUrl } from "./scispace-record-url.ts";
import {
  clearStage,
  emptyState,
  loadState,
  markCompleted,
  saveState,
  STAGES,
  type PaperState,
  type StageId,
} from "./state.ts";
import {
  collectExistingPapers,
  applySciSpaceMetaToPaperPage,
  runEduShareMaterials,
  runEduShareUpload,
  saveSciSpaceUrlOnEduShare,
  verifyEduSharePaper,
} from "./steps/edushare.ts";
import { runNotebookLm } from "./steps/notebooklm.ts";
import { captureSciSpaceCardMeta, captureSciSpaceRecordUrl, runSciSpace } from "./steps/scispace.ts";

export type BatchResult = {
  processed: string[];
  skipped: string[];
  failed: string[];
};

function applyFromStage(state: PaperState, from: StageId | null): void {
  if (!from) return;
  const idx = STAGES.indexOf(from);
  if (idx < 0) return;
  state.completed = state.completed.filter((s) => {
    const i = STAGES.indexOf(s);
    return i >= 0 && i < idx;
  });
  saveState(state);
}

/** タイトルだけ一致した既存スキップは、隣カードの誤メタのことがあるのでやり直す */
function undoTitleOnlyExistingSkip(state: PaperState, existing: ExistingPaper[]): boolean {
  if (!state.skippedAlreadyUploaded || state.eduShareTestId) return false;
  const byFileOrDoi = matchesExistingPaper(existing, {
    filename: state.filename,
    doi: state.doi,
  });
  if (byFileOrDoi) return false;
  log(
    `前回の既存スキップを取り消します（${state.filename}: ファイル名/DOI では一致せず、タイトルのみ）`,
  );
  state.skippedAlreadyUploaded = false;
  clearStage(state, "sci-meta");
  state.title = "";
  state.filesPaste = "";
  state.tldr = "";
  state.venue = "";
  state.doi = "";
  if (!isSciSpaceRecordUrl(state.scispaceUrl)) state.scispaceUrl = "";
  state.lastError = "";
  saveState(state);
  return true;
}

export async function repairSciSpaceRecordLinks(
  page: Page,
  cfg: AppConfig,
): Promise<{ updated: string[]; failed: string[] }> {
  const updated: string[] = [];
  const failed: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(cfg.workDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, "en"));
  } catch {
    return { updated, failed };
  }
  for (const name of names) {
    const paperDir = join(cfg.workDir, name);
    const fallback = emptyState({
      filename: `${name}.pdf`,
      inboxPdfPath: join(paperDir, `${name}.pdf`),
      paperDir,
    });
    const state = loadState(paperDir, fallback);
    if (cfg.onlyFilename && state.filename !== cfg.onlyFilename) continue;
    if (!state.eduShareTestUrl || !state.filename) continue;
    if (isSciSpaceRecordUrl(state.scispaceUrl)) continue;
    log(`--- SciSpace リンク補修 ${state.filename} ---`);
    try {
      if (!isSciSpaceRecordUrl(state.scispaceUrl)) {
        await captureSciSpaceRecordUrl(page, {
          folderUrl: cfg.scispaceFolderUrl,
          filename: state.filename,
          paperDir,
          state,
        });
        saveState(state);
      }
      if (!isSciSpaceRecordUrl(state.scispaceUrl)) {
        throw new Error(`SciSpace の個別ページ URL がありません（${state.filename}）`);
      }
      await saveSciSpaceUrlOnEduShare(page, state);
      updated.push(state.filename);
    } catch (e) {
      const msg = firstLine(e);
      state.lastError = msg;
      saveState(state);
      logError(`${state.filename}: SciSpace リンク補修に失敗: ${msg}`);
      failed.push(state.filename);
    }
  }
  return { updated, failed };
}

export async function repairSciSpaceCardMeta(
  page: Page,
  cfg: AppConfig,
  existing: ExistingPaper[] = [],
): Promise<{ updated: string[]; failed: string[] }> {
  const updated: string[] = [];
  const failed: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(cfg.workDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, "en"));
  } catch {
    return { updated, failed };
  }
  for (const name of names) {
    const paperDir = join(cfg.workDir, name);
    const fallback = emptyState({
      filename: `${name}.pdf`,
      inboxPdfPath: join(paperDir, `${name}.pdf`),
      paperDir,
    });
    const state = loadState(paperDir, fallback);
    if (!state.eduShareTestUrl || !state.filename) continue;
    log(`--- SciSpace メタ補修 ${state.filename} ---`);
    const before = {
      title: state.title,
      filesPaste: state.filesPaste,
      tldr: state.tldr,
      venue: state.venue,
    };
    try {
      await captureSciSpaceCardMeta(page, {
        folderUrl: cfg.scispaceFolderUrl,
        filename: state.filename,
        paperDir,
        state,
      });
      const oldTitleOk = titleUsableForExistingMatch(before.title, state.filename);
      const newTitleOk = titleUsableForExistingMatch(state.title, state.filename);
      if (oldTitleOk && !newTitleOk) {
        log(`${state.filename}: 新しいタイトルが弱いので前回のメタを残します`);
        state.title = before.title;
        state.filesPaste = before.filesPaste;
        state.tldr = before.tldr;
        state.venue = before.venue;
        saveState(state);
        continue;
      }
      saveState(state);
      const changed =
        before.title !== state.title ||
        before.filesPaste !== state.filesPaste ||
        before.tldr !== state.tldr;
      const listed = existing.some((e) => titlesLikelySame(e.title, state.title));
      if (!changed && listed) {
        log(`${state.filename}: SciSpace メタは変更なし`);
        continue;
      }
      log(
        `${state.filename}: メタを更新 title=${state.title.slice(0, 80)}`,
      );
      await applySciSpaceMetaToPaperPage(page, { paperDir, state });
      updated.push(state.filename);
    } catch (e) {
      const msg = firstLine(e);
      state.lastError = msg;
      saveState(state);
      logError(`${state.filename}: SciSpace メタ補修に失敗: ${msg}`);
      failed.push(state.filename);
    }
  }
  return { updated, failed };
}

export async function loadExistingFromEduShare(
  page: Page,
  cfg: AppConfig,
): Promise<ExistingPaper[]> {
  try {
    return await collectExistingPapers(page, cfg.eduShareBaseUrl, {
      email: cfg.eduShareEmail,
      password: cfg.eduSharePassword,
    });
  } catch (e) {
    warn(
      `論文一覧の取得に失敗しました（${e instanceof Error ? e.message : e}）。既存判定は弱くなります。`,
    );
    return [];
  }
}

export async function processOnePaper(
  page: Page,
  cfg: AppConfig,
  item: InboxPdf,
  existing: ExistingPaper[],
): Promise<"done" | "skipped" | "failed"> {
  if (hasDoneMarker(item.paperDir)) {
    log(`スキップ（作業完了済み）: ${item.filename}`);
    return "skipped";
  }

  ensurePaperDir(item.paperDir);
  let state = loadState(
    item.paperDir,
    emptyState({
      filename: item.filename,
      inboxPdfPath: item.absPath,
      paperDir: item.paperDir,
    }),
  );
  state.inboxPdfPath = item.absPath;
  state.filename = item.filename;
  state.paperDir = item.paperDir;
  saveState(state);

  undoTitleOnlyExistingSkip(state, existing);

  if (state.skippedAlreadyUploaded) {
    log(`スキップ（既存アップロード・前回判定）: ${item.filename}`);
    return "skipped";
  }

  const early = matchesExistingPaper(existing, {
    filename: item.filename,
    doi: state.doi,
  });
  if (early && !state.eduShareTestId) {
    log(`スキップ（Edu Share に既存: ${early.title || early.doi}）: ${item.filename}`);
    state.skippedAlreadyUploaded = true;
    saveState(state);
    return "skipped";
  }

  applyFromStage(state, cfg.fromStage && cfg.onlyFilename ? cfg.fromStage : null);

  try {
    await runNotebookLm(page, {
      homeUrl: cfg.notebooklmUrl,
      pdfPath: item.absPath,
      paperDir: item.paperDir,
      state,
    });

    await assertPageAlive(page);
    await runSciSpace(page, {
      folderUrl: cfg.scispaceFolderUrl,
      pdfPath: item.absPath,
      filename: item.filename,
      paperDir: item.paperDir,
      state,
    });

    const afterSci = matchesExistingPaper(existing, {
      filename: item.filename,
      title: titleUsableForExistingMatch(state.title, item.filename) ? state.title : "",
      doi: state.doi,
    });
    if (afterSci && !state.eduShareTestId) {
      log(
        `SciSpace 後スキップ（Edu Share に既存: ${afterSci.title || afterSci.doi}）。PDF は入力側に残します。`,
      );
      state.skippedAlreadyUploaded = true;
      saveState(state);
      return "skipped";
    }

    await runEduShareUpload(page, {
      baseUrl: cfg.eduShareBaseUrl,
      email: cfg.eduShareEmail,
      password: cfg.eduSharePassword,
      pdfPath: item.absPath,
      paperDir: item.paperDir,
      state,
    });

    await runEduShareMaterials(page, { paperDir: item.paperDir, state });
    await verifyEduSharePaper(page, { paperDir: item.paperDir, state });

    moveInboxPdfToPaperDir(item.absPath, item.paperDir);
    markCompleted(state, "done");
    writeDoneMarker(item.paperDir);
    log(`完了: ${item.filename} → ${item.paperDir}`);
    return "done";
  } catch (e) {
    const msg = firstLine(e);
    state.lastError = msg;
    saveState(state);
    logError(`${item.filename}: ${msg}`);
    return "failed";
  }
}