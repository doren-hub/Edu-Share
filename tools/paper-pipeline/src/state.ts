import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STAGES = [
  "sci-upload",
  "nlm-create",
  "nlm-upload",
  "nlm-slides",
  "nlm-video",
  "nlm-quiz",
  "nlm-flashcards",
  "sci-meta",
  "edu-upload",
  "edu-materials",
  "verify",
  "done",
] as const;

export type StageId = (typeof STAGES)[number];

export const STUDIO_STAGES = [
  "nlm-slides",
  "nlm-video",
  "nlm-quiz",
  "nlm-flashcards",
] as const;

export type StudioStageId = (typeof STUDIO_STAGES)[number];

export const SKIP_SLIDES_VIDEO_STAGES: readonly StudioStageId[] = ["nlm-slides", "nlm-video"];

export type PaperState = {
  filename: string;
  inboxPdfPath: string;
  paperDir: string;
  completed: StageId[];
  notebooklmUrl: string;
  scispaceUrl: string;
  eduShareTestUrl: string;
  eduShareTestId: string;
  title: string;
  doi: string;
  venue: string;
  filesPaste: string;
  tldr: string;
  slidePdfPath: string;
  videoMp4Path: string;
  quizCsvPath: string;
  vocabCsvPath: string;
  skippedAlreadyUploaded: boolean;
  lastError: string;
  waitingFor: StageId | "";
  generationStartedAt: string;
  studioStarted: StageId[];
  /** 生成ボタン失敗などのあと、この時刻まで Studio 開始を飛ばす */
  kickoffRetryAt: string;
  /** kickoffRetryAt の対象段階。他の Studio は後回しにしない */
  kickoffRetryStage: StageId | "";
  /** Edu Share に載せ済みの Studio 成果物。利用量待ちの途中アップロード用 */
  eduUploaded: StudioStageId[];
};

export function emptyState(partial: Pick<PaperState, "filename" | "inboxPdfPath" | "paperDir">): PaperState {
  return {
    filename: partial.filename,
    inboxPdfPath: partial.inboxPdfPath,
    paperDir: partial.paperDir,
    completed: [],
    notebooklmUrl: "",
    scispaceUrl: "",
    eduShareTestUrl: "",
    eduShareTestId: "",
    title: "",
    doi: "",
    venue: "",
    filesPaste: "",
    tldr: "",
    slidePdfPath: "",
    videoMp4Path: "",
    quizCsvPath: "",
    vocabCsvPath: "",
    skippedAlreadyUploaded: false,
    lastError: "",
    waitingFor: "",
    generationStartedAt: "",
    studioStarted: [],
    kickoffRetryAt: "",
    kickoffRetryStage: "",
    eduUploaded: [],
  };
}

export function statePath(paperDir: string): string {
  return join(paperDir, "state.json");
}

export function doneMarkerPath(paperDir: string): string {
  return join(paperDir, "DONE");
}

export function loadState(paperDir: string, fallback: PaperState): PaperState {
  const p = statePath(paperDir);
  if (!existsSync(p)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<PaperState>;
    const studioStarted = Array.isArray(parsed.studioStarted)
      ? parsed.studioStarted.filter((s): s is StageId => isStageId(s))
      : [];
    const eduUploaded = Array.isArray(parsed.eduUploaded)
      ? parsed.eduUploaded.filter((s): s is StudioStageId =>
          (STUDIO_STAGES as readonly string[]).includes(s),
        )
      : [];
    return {
      ...fallback,
      ...parsed,
      studioStarted,
      eduUploaded,
      kickoffRetryStage:
        parsed.kickoffRetryStage && isStageId(parsed.kickoffRetryStage) ? parsed.kickoffRetryStage : "",
      paperDir,
      inboxPdfPath: fallback.inboxPdfPath,
    };
  } catch {
    return fallback;
  }
}

export function saveState(state: PaperState): void {
  mkdirSync(state.paperDir, { recursive: true });
  writeFileSync(statePath(state.paperDir), JSON.stringify(state, null, 2), "utf8");
}

export function markCompleted(state: PaperState, stage: StageId): void {
  if (!state.completed.includes(stage)) state.completed.push(stage);
  if (state.waitingFor === stage) {
    state.waitingFor = "";
    state.generationStartedAt = "";
  }
  saveState(state);
}

export function hasStudioStarted(state: PaperState, stage: StageId): boolean {
  return (state.studioStarted ?? []).includes(stage) || state.waitingFor === stage;
}

export function firstPendingStudioStage(
  state: PaperState,
  skip: readonly StudioStageId[] = [],
): StudioStageId | undefined {
  return STUDIO_STAGES.find((s) => !isCompleted(state, s) && !skip.includes(s));
}

export function waitingStudioStage(
  state: PaperState,
  skip: readonly StudioStageId[] = [],
): StudioStageId | undefined {
  return STUDIO_STAGES.find((s) => !isCompleted(state, s) && !skip.includes(s) && hasStudioStarted(state, s));
}

/** スライド・動画・クイズ・単語帳のうち、この論文で扱うもの */
export function requiredStudioStages(skip: readonly StudioStageId[] = []): StudioStageId[] {
  return STUDIO_STAGES.filter((s) => !skip.includes(s));
}

export function studioKickoffBegun(state: PaperState, skip: readonly StudioStageId[] = []): boolean {
  return requiredStudioStages(skip).some((s) => isCompleted(state, s) || hasStudioStarted(state, s));
}

/** 4種それぞれが生成待ち（開始済み）か完了 */
export function studioKickoffSettled(state: PaperState, skip: readonly StudioStageId[] = []): boolean {
  return requiredStudioStages(skip).every((s) => isCompleted(state, s) || hasStudioStarted(state, s));
}

export function markStudioStarted(state: PaperState, stage: StageId): void {
  if (!state.studioStarted) state.studioStarted = [];
  if (!state.studioStarted.includes(stage)) state.studioStarted.push(stage);
  saveState(state);
}

export function markEduUploaded(state: PaperState, stage: StudioStageId): void {
  if (!state.eduUploaded) state.eduUploaded = [];
  if (!state.eduUploaded.includes(stage)) state.eduUploaded.push(stage);
  saveState(state);
}

export function unmarkEduUploaded(state: PaperState, stage: StudioStageId): void {
  state.eduUploaded = (state.eduUploaded ?? []).filter((s) => s !== stage);
  saveState(state);
}

export function unmarkStudioStarted(state: PaperState, stage: StageId): void {
  state.studioStarted = (state.studioStarted ?? []).filter((s) => s !== stage);
  if (state.waitingFor === stage) {
    state.waitingFor = "";
    state.generationStartedAt = "";
  }
  saveState(state);
}

export function isCompleted(state: PaperState, stage: StageId): boolean {
  return state.completed.includes(stage) || state.completed.includes("done");
}

export function clearStage(state: PaperState, stage: StageId): void {
  state.completed = state.completed.filter((s) => s !== stage);
}

export function isStageId(s: string): s is StageId {
  return (STAGES as readonly string[]).includes(s);
}
