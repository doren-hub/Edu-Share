import {
  hasStudioStarted,
  isCompleted,
  studioKickoffBegun,
  studioKickoffSettled,
  type PaperState,
  type StudioStageId,
} from "./state.ts";
import { missingStudioStages, studioArtifactReady } from "./studio-select.ts";
import { needsSciSpaceCardRecapture, rawFilesCardPaste } from "./scispace-card.ts";
import { needsLocalVideoFile } from "./video-file.ts";
import { isRetryCooling } from "./waiting.ts";

export function hasAnyStudioArtifact(
  state: PaperState,
  selected: readonly StudioStageId[],
): boolean {
  return selected.some((s) => isCompleted(state, s) || studioArtifactReady(state, s));
}

export function missingEduUploads(
  state: PaperState,
  selected: readonly StudioStageId[],
): StudioStageId[] {
  const uploaded = new Set(state.eduUploaded ?? []);
  return selected.filter((s) => studioArtifactReady(state, s) && !uploaded.has(s));
}

/** NotebookLM で生成済みの可能性があるが、ローカルにまだ無い Studio 出力 */
export function hasPendingStudioHarvest(
  state: PaperState,
  selected: readonly StudioStageId[],
): boolean {
  if (!state.notebooklmUrl?.trim()) return false;
  return missingStudioStages(state, selected).some((s) => {
    if (isCompleted(state, s)) return false;
    if (s === "nlm-video" && needsLocalVideoFile(state)) return false;
    return hasStudioStarted(state, s);
  });
}

/** 利用量が止まっているあいだに進められる作業がある */
export function hasHarvestableWork(
  state: PaperState,
  selected: readonly StudioStageId[],
): boolean {
  if (state.skippedAlreadyUploaded && !state.eduShareTestId && !state.eduShareTestUrl) {
    return false;
  }
  if (isRetryCooling(state)) {
    if (!isCompleted(state, "sci-upload")) return true;
    if (hasAnyStudioArtifact(state, selected)) {
      if (!isCompleted(state, "edu-upload")) return true;
      if (missingEduUploads(state, selected).length > 0) return true;
    }
    if (hasPendingStudioHarvest(state, selected)) return true;
    return false;
  }
  if (needsLocalVideoFile(state)) return true;
  if (!isCompleted(state, "sci-upload")) return true;
  if (!isCompleted(state, "sci-meta") || !rawFilesCardPaste(state.filesPaste, state.filename)) return true;
  if (needsSciSpaceCardRecapture(state)) return true;
  if (hasAnyStudioArtifact(state, selected)) {
    if (!isCompleted(state, "edu-upload")) return true;
    if (missingEduUploads(state, selected).length > 0) return true;
    if (!isCompleted(state, "verify")) return true;
  }
  if (
    !shouldSkipNotebookVisit(state, selected) &&
    state.notebooklmUrl &&
    studioKickoffBegun(state) &&
    missingStudioStages(state, selected).length > 0
  ) {    return true;
  }
  return false;
}

/** Chrome 切断後やメタ未取得のとき、Studio を開き直さない */
export function shouldSkipNotebookVisit(
  state: PaperState,
  selected: readonly StudioStageId[],
  opts: { skipKickoff?: boolean; skipStudio?: boolean } = {},
): boolean {
  if (hasPendingStudioHarvest(state, selected)) return false;
  if (needsLocalVideoFile(state) && !isRetryCooling(state)) return false;
  if (needsLocalVideoFile(state)) return true;
  if (opts.skipStudio) return true;
  if (!studioKickoffSettled(state)) return false;
  if (!isCompleted(state, "sci-meta") || !rawFilesCardPaste(state.filesPaste, state.filename)) {
    return true;
  }
  if (needsSciSpaceCardRecapture(state) && !hasPendingStudioHarvest(state, selected)) return true;
  if (opts.skipKickoff && hasAnyStudioArtifact(state, selected)) return true;
  if (selected.length > 0 && selected.every((s) => isCompleted(state, s))) return true;
  return false;
}
