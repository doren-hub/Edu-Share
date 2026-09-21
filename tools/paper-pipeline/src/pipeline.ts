import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { AppConfig } from "./config.ts";
import { assertPageAlive, isTargetClosedError, isTargetClosedMessage, recoverStuckPage } from "./browser.ts";
import {
  ensurePaperDir,
  existingWorkPapersExcept,
  hasDoneMarker,
  moveInboxPdfToPaperDir,
  writeDoneMarker,
  type InboxPdf,
} from "./inbox.ts";
import { error as logError, firstLine, log, warn } from "./log.ts";
import { matchesExistingPaper, titleUsableForExistingMatch, type ExistingPaper } from "./match.ts";
import { isSciSpaceRecordUrl } from "./scispace-record-url.ts";
import {
  clearStage,
  doneMarkerPath,
  emptyState,
  firstPendingStudioStage,
  isCompleted,
  loadState,
  markCompleted,
  markStudioStarted,
  saveState,
  STAGES,
  studioKickoffBegun,
  studioKickoffSettled,
  unmarkStudioStarted,
  type PaperState,
  type StageId,
  type StudioStageId,
} from "./state.ts";
import {
  attachEduShareVideo,
  applySciSpaceMetaToPaperPage,
  runEduShareMaterials,
  runEduShareUpload,
  saveSciSpaceUrlOnEduShare,
  verifyEduSharePaper,
} from "./steps/edushare.ts";
import { runNotebookLm } from "./steps/notebooklm.ts";
import { captureSciSpaceCardMeta, captureSciSpaceRecordUrl, runSciSpaceMeta, runSciSpaceUpload } from "./steps/scispace.ts";
import {
  descriptionUsable,
  needsSciSpaceCardRecapture,
  sciSpaceTldrLooksLikeChrome,
  sciSpaceTitleLooksLikeChrome,
  tldrUsable,
} from "./scispace-card.ts";
import { GenerationWaitingError } from "./waiting.ts";
import { currentNotebookQuotaPause, NotebookQuotaPauseError } from "./notebook-quota.ts";
import { needsLocalVideoFile, videoFileReady } from "./video-file.ts";
import { formatStudioGenerateJa, missingStudioStages } from "./studio-select.ts";
import { hasAnyStudioArtifact, missingEduUploads, shouldSkipNotebookVisit } from "./harvest.ts";

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
  if (state.waitingFor && STAGES.indexOf(state.waitingFor) >= idx) {
    state.waitingFor = "";
    state.generationStartedAt = "";
  }
  state.studioStarted = (state.studioStarted ?? []).filter((s) => STAGES.indexOf(s) < idx);
  saveState(state);
}

/** ファイル名では一致しない既存スキップは、タイトル誤判定のことがあるのでやり直す */
function undoTitleOnlyExistingSkip(state: PaperState, existing: ExistingPaper[]): boolean {
  if (!state.skippedAlreadyUploaded || state.eduShareTestId) return false;
  const byFile = matchesExistingPaper(existing, {
    filename: state.filename,
  });
  if (byFile) return false;
  log(
    `前回の既存スキップを取り消します（${state.filename}: PDF 名称では一致しません）`,
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

function adoptExistingEduSharePaper(
  state: PaperState,
  hit: ExistingPaper,
  baseUrl: string,
): boolean {
  if (!hit.id) return false;
  const url = hit.url || `${baseUrl.replace(/\/$/, "")}/tests/${hit.id}`;
  log(`Edu Share に既存なので論文ページへつなぎます: ${hit.filename || hit.title || hit.id}`);
  state.eduShareTestId = hit.id;
  state.eduShareTestUrl = url;
  state.skippedAlreadyUploaded = false;
  state.lastError = "";
  if (!state.completed.includes("edu-upload")) markCompleted(state, "edu-upload");
  else saveState(state);
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
  _existing: ExistingPaper[] = [],
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
    if (!needsSciSpaceCardRecapture(state)) continue;
    log(`--- SciSpace メタ補修 ${state.filename} ---`);
    const before = {
      title: state.title,
      filesPaste: state.filesPaste,
      tldr: state.tldr,
      venue: state.venue,
      doi: state.doi,
    };
    try {
      if (!(await recoverStuckPage(page))) {
        throw new Error("ブラウザが閉じられています");
      }
      await captureSciSpaceCardMeta(page, {
        folderUrl: cfg.scispaceFolderUrl,
        filename: state.filename,
        paperDir,
        state,
      });
      const oldTitleOk = titleUsableForExistingMatch(before.title, state.filename);
      const newTitleOk = titleUsableForExistingMatch(state.title, state.filename);
      const titleChrome = sciSpaceTitleLooksLikeChrome(state.title);
      const tldrChrome = sciSpaceTldrLooksLikeChrome(state.tldr);
      if (titleChrome || (oldTitleOk && !newTitleOk)) {
        log(`${state.filename}: SciSpace 画面の文言なので前回のメタを残します`);
        state.title = before.title;
        state.filesPaste = before.filesPaste;
        state.venue = before.venue;
        state.doi = before.doi;
      }
      if (tldrChrome) {
        log(`${state.filename}: SciSpace 画面の文言なので前回の TL;DR を残します`);
        state.tldr = descriptionUsable(before.tldr)
          ? before.tldr
          : tldrUsable(before.tldr)
            ? before.tldr
            : "";
      } else if (!descriptionUsable(state.tldr) && descriptionUsable(before.tldr)) {
        state.tldr = before.tldr;
      } else if (!tldrUsable(state.tldr) && tldrUsable(before.tldr)) {
        state.tldr = before.tldr;
      }
      if (titleChrome || (oldTitleOk && !newTitleOk)) {
        state.lastError = "";
        saveState(state);
        if (oldTitleOk) {
          await applySciSpaceMetaToPaperPage(page, { paperDir, state });
        }
        continue;
      }
      saveState(state);
      const changed =
        before.title !== state.title ||
        before.filesPaste !== state.filesPaste ||
        before.tldr !== state.tldr ||
        before.venue !== state.venue ||
        before.doi !== state.doi;
      const needsTldr = !descriptionUsable(state.tldr);
      if (!changed && needsTldr) {
        log(`${state.filename}: TL;DR が無いので Edu Share の説明を埋めます`);
      } else if (!changed) {
        log(`${state.filename}: SciSpace メタは変更なし。Edu Share の説明を入れます`);
      }
      log(
        `${state.filename}: メタを更新 title=${state.title.slice(0, 80)}`,
      );
      await applySciSpaceMetaToPaperPage(page, { paperDir, state });
      if (needsSciSpaceCardRecapture(state) && /Files に .+ が見つかりません/.test(state.lastError)) {
        log(`${state.filename}: Files に無いので後回しにします`);
      } else {
        state.lastError = "";
      }
      if (isSciSpaceRecordUrl(state.scispaceUrl)) {
        markCompleted(state, "sci-meta");
      }
      saveState(state);
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

function reopenStudioFollowup(
  state: PaperState,
  selected: readonly StudioStageId[],
  paperDir: string,
): boolean {
  const missing = missingStudioStages(state, selected);
  if (missing.length === 0) return false;
  for (const stage of missing) {
    clearStage(state, stage);
    unmarkStudioStarted(state, stage);
  }
  for (const stage of ["edu-materials", "verify", "done"] as const) {
    clearStage(state, stage);
  }
  if (missing.includes(state.waitingFor as StudioStageId)) {
    state.waitingFor = "";
    state.generationStartedAt = "";
  }
  state.skippedAlreadyUploaded = false;
  saveState(state);
  try {
    unlinkSync(doneMarkerPath(paperDir));
  } catch {
    /* 無ければ続行 */
  }
  log(`後から生成: ${formatStudioGenerateJa(missing)}（${state.filename}）`);
  return true;
}

export async function processOnePaper(
  page: Page,
  cfg: AppConfig,
  item: InboxPdf,
  _existing: ExistingPaper[] = [],
  opts: { skipStudio?: boolean } = {},
): Promise<"done" | "skipped" | "failed" | "waiting" | "quota"> {
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
  if (state.waitingFor && isCompleted(state, state.waitingFor)) {
    log(`${item.filename}: ${state.waitingFor} は完了済みなので待ちを外します`);
    state.waitingFor = "";
    state.generationStartedAt = "";
  }
  saveState(state);

  const selected = cfg.studioGenerate;
  if (hasDoneMarker(item.paperDir) && needsLocalVideoFile(state)) {
    log(`${item.filename}: 完了済みだが動画 MP4 が無いので Edu Share へ載せ直します`);
    clearStage(state, "done");
    clearStage(state, "verify");
    saveState(state);
    try {
      unlinkSync(doneMarkerPath(item.paperDir));
    } catch {
      /* 無ければ続行 */
    }
  } else if (hasDoneMarker(item.paperDir) && needsSciSpaceCardRecapture(state)) {
    if (/Files に .+ が見つかりません/.test(state.lastError)) {
      log(`${item.filename}: Files に無いので SciSpace メタ取り直しは後回しにします`);
      return "skipped";
    }
    log(`${item.filename}: 完了済みだが SciSpace メタが不足なので取り直します`);
    clearStage(state, "done");
    saveState(state);
    try {
      unlinkSync(doneMarkerPath(item.paperDir));
    } catch {
      /* 無ければ続行 */
    }
  } else if (hasDoneMarker(item.paperDir)) {
    if (!reopenStudioFollowup(state, selected, item.paperDir)) {
      log(`スキップ（作業完了済み）: ${item.filename}`);
      return "skipped";
    }
  }

  undoTitleOnlyExistingSkip(state, existingWorkPapersExcept(cfg.workDir, item.paperDir));

  if (
    state.skippedAlreadyUploaded &&
    !state.eduShareTestId &&
    !state.eduShareTestUrl
  ) {
    log(`スキップ（既存アップロード・前回判定）: ${item.filename}`);
    return "skipped";
  }
  if (state.skippedAlreadyUploaded) {
    if (!reopenStudioFollowup(state, selected, item.paperDir)) {
      log(`スキップ（指定した生成物は揃っています）: ${item.filename}`);
      return "skipped";
    }
  }

  const existing = existingWorkPapersExcept(cfg.workDir, item.paperDir);
  const early = matchesExistingPaper(existing, {
    filename: item.filename,
  });
  if (early && !state.eduShareTestId) {
    if (adoptExistingEduSharePaper(state, early, cfg.eduShareBaseUrl)) {
      reopenStudioFollowup(state, selected, item.paperDir);
    } else {
      log(`スキップ（作業フォルダに既存: ${early.filename || early.title}）: ${item.filename}`);
      state.skippedAlreadyUploaded = true;
      saveState(state);
      return "skipped";
    }
  }

  applyFromStage(state, cfg.fromStage && cfg.onlyFilename ? cfg.fromStage : null);

  const quotaPause = await currentNotebookQuotaPause(cfg);
  const skipStudioAfterDisconnect =
    isTargetClosedMessage(state.lastError) &&
    studioKickoffSettled(state, cfg.studioSkip) &&
    videoFileReady(item.paperDir, state.videoMp4Path);
  const skipKickoff = quotaPause != null;
  const forceSkipStudio = opts.skipStudio === true || skipStudioAfterDisconnect;
  const skipStudio =
    forceSkipStudio ||
    shouldSkipNotebookVisit(state, selected, {
      skipKickoff,
      skipStudio: forceSkipStudio,
    });

  try {
    await runSciSpaceUpload(page, {
      folderUrl: cfg.scispaceFolderUrl,
      pdfPath: item.absPath,
      filename: item.filename,
      paperDir: item.paperDir,
      state,
    });

    if (skipStudio) {
      log(`${item.filename}: Studio は開かず、SciSpace メタ / Edu Share を先に進めます`);
    } else {
      await runNotebookLm(page, {
        homeUrl: cfg.notebooklmUrl,
        pdfPath: item.absPath,
        paperDir: item.paperDir,
        state,
        studioSkip: cfg.studioSkip,
        quota: cfg,
        skipKickoff,
      });
    }

    if (!(await recoverStuckPage(page))) {
      throw new Error("ブラウザが閉じられています");
    }
    await assertPageAlive(page);
    await runSciSpaceMeta(page, {
      folderUrl: cfg.scispaceFolderUrl,
      filename: item.filename,
      paperDir: item.paperDir,
      state,
    });
    if (state.eduShareTestUrl && state.filesPaste.trim()) {
      await applySciSpaceMetaToPaperPage(page, { paperDir: item.paperDir, state });
    }

    const afterSci = matchesExistingPaper(existingWorkPapersExcept(cfg.workDir, item.paperDir), {
      filename: item.filename,
    });
    if (afterSci && !state.eduShareTestId) {
      if (!adoptExistingEduSharePaper(state, afterSci, cfg.eduShareBaseUrl)) {
        log(
          `SciSpace 後スキップ（作業フォルダに既存: ${afterSci.filename || afterSci.title}）。PDF は入力側に残します。`,
        );
        state.skippedAlreadyUploaded = true;
        saveState(state);
        return "skipped";
      }
    }

    const canHarvestEdu = hasAnyStudioArtifact(state, selected);
    if (skipKickoff) {
      if (canHarvestEdu) {
        log(
          `${item.filename}: 利用量回復待ちのため、できている生成物を Edu Share / SciSpace へ先に載せます`,
        );
        await runEduShareUpload(page, {
          baseUrl: cfg.eduShareBaseUrl,
          email: cfg.eduShareEmail,
          password: cfg.eduSharePassword,
          pdfPath: item.absPath,
          paperDir: item.paperDir,
          state,
        });
        await runEduShareMaterials(page, {
          paperDir: item.paperDir,
          state,
          selected,
        });
        await attachEduShareVideo(page, state);
      } else {
        log(`${item.filename}: Notebook 利用量のため生成は止め、SciSpace まで進めました`);
      }
      const stillPending = firstPendingStudioStage(state, cfg.studioSkip);
      if (
        stillPending ||
        !isCompleted(state, "sci-meta") ||
        missingEduUploads(state, selected).length > 0
      ) {
        return "quota";
      }
    }

    await runEduShareUpload(page, {
      baseUrl: cfg.eduShareBaseUrl,
      email: cfg.eduShareEmail,
      password: cfg.eduSharePassword,
      pdfPath: item.absPath,
      paperDir: item.paperDir,
      state,
    });

    await runEduShareMaterials(page, { paperDir: item.paperDir, state, selected });
    await attachEduShareVideo(page, state);
    const pendingStudio = firstPendingStudioStage(state, cfg.studioSkip);
    if (pendingStudio) {
      log(
        `${item.filename}: SciSpace / Edu Share まで進めたので、残りの ${pendingStudio} は生成待ちとして明け渡します`,
      );
      throw new GenerationWaitingError(pendingStudio);
    }
    if (
      !cfg.studioSkip.includes("nlm-video") &&
      state.completed.includes("nlm-video") &&
      !videoFileReady(item.paperDir, state.videoMp4Path)
    ) {
      warn("解説動画の MP4 がまだ無いので、Edu Share 確認は後回しにします");
      throw new GenerationWaitingError("nlm-video");
    }
    await verifyEduSharePaper(page, {
      paperDir: item.paperDir,
      state,
      studioSkip: cfg.studioSkip,
    });

    state.lastError = "";
    moveInboxPdfToPaperDir(item.absPath, item.paperDir);
    markCompleted(state, "done");
    writeDoneMarker(item.paperDir);
    log(`完了: ${item.filename} → ${item.paperDir}`);
    return "done";
  } catch (e) {
    if (e instanceof GenerationWaitingError) {
      state.waitingFor = e.stage;
      if (!state.generationStartedAt) state.generationStartedAt = new Date().toISOString();
      if (!skipStudio) markStudioStarted(state, e.stage);
      state.lastError = "";
      saveState(state);
      log(`${item.filename}: 生成待ち（${e.stage}）。Chrome を明け渡します`);
      return "waiting";
    }
    if (e instanceof NotebookQuotaPauseError) {
      state.lastError = "";
      saveState(state);
      log(`${item.filename}: ${e.message}`);
      return "quota";
    }
    const msg = firstLine(e);
    state.lastError = msg;
    saveState(state);
    logError(`${item.filename}: ${msg}`);
    if (isTargetClosedError(e) && studioKickoffBegun(state, cfg.studioSkip)) {
      const stage = firstPendingStudioStage(state, cfg.studioSkip) || state.waitingFor || "nlm-video";
      state.waitingFor = stage;
      if (!state.generationStartedAt) state.generationStartedAt = new Date().toISOString();
      saveState(state);
      log(`${item.filename}: ブラウザ切断のため Studio 再生成はせず、Chrome を明け渡します`);
      return "waiting";
    }
    return "failed";
  }
}