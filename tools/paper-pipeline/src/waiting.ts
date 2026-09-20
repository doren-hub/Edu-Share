import type { StageId } from "./state.ts";

/** worker が生成待ちで Chrome を明け渡したときの終了コード */
export const EXIT_WAITING = 10;

export class GenerationWaitingError extends Error {
  constructor(readonly stage: StageId) {
    super(`Studio 生成待ちのため一旦明け渡します（${stage}）`);
    this.name = "GenerationWaitingError";
  }
}

export function recheckDelayMs(stage: string): number {
  if (stage === "nlm-video") return 60_000;
  if (stage === "nlm-slides") return 90_000;
  if (stage === "nlm-quiz" || stage === "nlm-flashcards") return 20_000;
  return 30_000;
}

export function isStudioStage(stage: string): stage is StageId {
  return (
    stage === "nlm-slides" ||
    stage === "nlm-video" ||
    stage === "nlm-quiz" ||
    stage === "nlm-flashcards"
  );
}
