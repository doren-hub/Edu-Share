import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STAGES = [
  "nlm-create",
  "nlm-upload",
  "nlm-slides",
  "nlm-video",
  "nlm-quiz",
  "nlm-flashcards",
  "sci-upload",
  "sci-meta",
  "edu-upload",
  "edu-materials",
  "verify",
  "done",
] as const;

export type StageId = (typeof STAGES)[number];

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
    return { ...fallback, ...parsed, paperDir, inboxPdfPath: fallback.inboxPdfPath };
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
