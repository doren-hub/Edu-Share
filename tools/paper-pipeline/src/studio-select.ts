import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  STUDIO_STAGES,
  type PaperState,
  type StudioStageId,
} from "./state.ts";
import { videoFileReady } from "./video-file.ts";

const TOKEN_TO_STAGE: Record<string, StudioStageId | "all"> = {
  all: "all",
  slides: "nlm-slides",
  slide: "nlm-slides",
  video: "nlm-video",
  quiz: "nlm-quiz",
  flashcards: "nlm-flashcards",
  flashcard: "nlm-flashcards",
};

export const STUDIO_GENERATE_CLI: Record<StudioStageId, string> = {
  "nlm-slides": "slides",
  "nlm-video": "video",
  "nlm-quiz": "quiz",
  "nlm-flashcards": "flashcards",
};

export const STUDIO_GENERATE_JA: Record<StudioStageId, string> = {
  "nlm-slides": "スライド",
  "nlm-video": "動画",
  "nlm-quiz": "クイズ",
  "nlm-flashcards": "フラッシュカード",
};

function normalizeToken(raw: string): string {
  return raw.trim().replace(/^--/, "").toLowerCase();
}

function lookupToken(raw: string): StudioStageId | "all" | undefined {
  const key = normalizeToken(raw);
  if (!key) return undefined;
  return TOKEN_TO_STAGE[key];
}

export function splitGenerateArg(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 空・all は 4 種すべて。順はスライド → 動画 → クイズ → フラッシュカード */
export function parseStudioGenerateTokens(tokens: readonly string[]): StudioStageId[] {
  if (tokens.length === 0) return [...STUDIO_STAGES];
  const wanted = new Set<StudioStageId>();
  let all = false;
  for (const raw of tokens) {
    const mapped = lookupToken(raw);
    if (!mapped) {
      throw new Error(
        `不明な --generate: ${raw}（slides / video / quiz / flashcards / all）`,
      );
    }
    if (mapped === "all") all = true;
    else wanted.add(mapped);
  }
  if (all) return [...STUDIO_STAGES];
  return STUDIO_STAGES.filter((s) => wanted.has(s));
}

export function skipStudioStages(selected: readonly StudioStageId[]): StudioStageId[] {
  return STUDIO_STAGES.filter((s) => !selected.includes(s));
}

export function formatStudioGenerateArg(selected: readonly StudioStageId[]): string {
  if (selected.length === STUDIO_STAGES.length) return "all";
  return selected.map((s) => STUDIO_GENERATE_CLI[s]).join(",");
}

export function formatStudioGenerateJa(selected: readonly StudioStageId[]): string {
  return selected.map((s) => STUDIO_GENERATE_JA[s]).join("・");
}

function fileHasBytes(path: string, minBytes: number): boolean {
  try {
    return existsSync(path) && statSync(path).size >= minBytes;
  } catch {
    return false;
  }
}

export function studioArtifactPath(state: PaperState, stage: StudioStageId): string {
  if (stage === "nlm-slides") {
    return state.slidePdfPath.trim() || join(state.paperDir, "slides.pdf");
  }
  if (stage === "nlm-video") {
    return state.videoMp4Path.trim() || join(state.paperDir, "video.mp4");
  }
  if (stage === "nlm-quiz") {
    return state.quizCsvPath.trim() || join(state.paperDir, "quiz.csv");
  }
  return state.vocabCsvPath.trim() || join(state.paperDir, "vocab.csv");
}

export function studioArtifactReady(state: PaperState, stage: StudioStageId): boolean {
  if (stage === "nlm-video") return videoFileReady(state.paperDir, state.videoMp4Path);
  const min = stage === "nlm-slides" ? 1_000 : 20;
  return fileHasBytes(studioArtifactPath(state, stage), min);
}

export function missingStudioStages(
  state: PaperState,
  selected: readonly StudioStageId[],
): StudioStageId[] {
  return selected.filter((s) => !studioArtifactReady(state, s));
}
