import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindEduSharePaper,
  emptyState,
  firstPendingStudioStage,
  hasStudioStarted,
  SKIP_SLIDES_VIDEO_STAGES,
  STAGES,
  studioKickoffBegun,
  studioKickoffSettled,
  unmarkStudioStarted,
  waitingStudioStage,
  type PaperState,
} from "./state.ts";

function paper(partial: Partial<PaperState> = {}): PaperState {
  return {
    ...emptyState({
      filename: "a.pdf",
      inboxPdfPath: "/tmp/a.pdf",
      paperDir: "/tmp/a",
    }),
    ...partial,
  };
}

test("STAGES: SciSpace 掲載は NotebookLM より前、メタ取得は Studio のあと", () => {
  const i = (s: string) => STAGES.indexOf(s as (typeof STAGES)[number]);
  assert.ok(i("sci-upload") < i("nlm-create"));
  assert.ok(i("nlm-flashcards") < i("sci-meta"));
});

test("firstPendingStudioStage: 未完了の Studio をスライドから順に返す", () => {
  assert.equal(firstPendingStudioStage(paper()), "nlm-slides");
  assert.equal(
    firstPendingStudioStage(paper({ completed: ["nlm-create", "nlm-upload", "nlm-slides"] })),
    "nlm-video",
  );
  assert.equal(
    firstPendingStudioStage(
      paper({ completed: ["nlm-slides", "nlm-video", "nlm-quiz", "nlm-flashcards"] }),
    ),
    undefined,
  );
  assert.equal(firstPendingStudioStage(paper(), SKIP_SLIDES_VIDEO_STAGES), "nlm-quiz");
});

test("waitingStudioStage: 開始済みで未完了の項目だけを待つ", () => {
  const slidesWaiting = paper({ waitingFor: "nlm-slides" });
  assert.equal(waitingStudioStage(slidesWaiting), "nlm-slides");
  assert.equal(hasStudioStarted(slidesWaiting, "nlm-slides"), true);
  assert.equal(hasStudioStarted(slidesWaiting, "nlm-video"), false);

  const videoStarted = paper({
    completed: ["nlm-slides"],
    studioStarted: ["nlm-video", "nlm-quiz"],
  });
  assert.equal(firstPendingStudioStage(videoStarted), "nlm-video");
  assert.equal(waitingStudioStage(videoStarted), "nlm-video");
  assert.equal(hasStudioStarted(videoStarted, "nlm-quiz"), true);
});

test("unmarkStudioStarted: 誤った開始記録を消す", () => {
  const state = paper({
    waitingFor: "nlm-video",
    studioStarted: ["nlm-slides", "nlm-video"],
  });
  unmarkStudioStarted(state, "nlm-video");
  assert.deepEqual(state.studioStarted, ["nlm-slides"]);
  assert.equal(state.waitingFor, "");
  assert.equal(hasStudioStarted(state, "nlm-video"), false);
});

test("studioKickoffSettled: 4種が開始済みか完了なら揃ったとみなす", () => {
  assert.equal(studioKickoffBegun(paper()), false);
  assert.equal(studioKickoffSettled(paper()), false);

  const quizOnly = paper({ studioStarted: ["nlm-quiz"] });
  assert.equal(studioKickoffBegun(quizOnly), true);
  assert.equal(studioKickoffSettled(quizOnly), false);

  const allStarted = paper({
    studioStarted: ["nlm-slides", "nlm-video", "nlm-quiz", "nlm-flashcards"],
  });
  assert.equal(studioKickoffSettled(allStarted), true);

  const mixed = paper({
    completed: ["nlm-slides", "nlm-quiz"],
    studioStarted: ["nlm-video", "nlm-flashcards"],
  });
  assert.equal(studioKickoffSettled(mixed), true);

  const skipQuizStarted = paper({ studioStarted: ["nlm-quiz", "nlm-flashcards"] });
  assert.equal(studioKickoffSettled(skipQuizStarted, SKIP_SLIDES_VIDEO_STAGES), true);
  assert.equal(studioKickoffSettled(skipQuizStarted), false);
});

test("bindEduSharePaper: 論文 ID が変わったら載せ済み印と DONE を捨てる", () => {
  const paperDir = mkdtempSync(join(tmpdir(), "pp-bind-edu-"));
  try {
    writeFileSync(join(paperDir, "DONE"), "ok\n");
    const state = paper({
      paperDir,
      eduShareTestId: "old-id",
      eduShareTestUrl: "http://localhost:3000/tests/old-id",
      completed: ["edu-upload", "edu-materials", "verify", "done"],
      eduUploaded: ["nlm-quiz", "nlm-flashcards", "nlm-slides", "nlm-video"],
    });
    assert.equal(
      bindEduSharePaper(state, "new-id", "http://localhost:3000/tests/new-id"),
      true,
    );
    assert.equal(state.eduShareTestId, "new-id");
    assert.equal(state.eduShareTestUrl, "http://localhost:3000/tests/new-id");
    assert.deepEqual(state.eduUploaded, []);
    assert.equal(state.completed.includes("done"), false);
    assert.equal(state.completed.includes("edu-materials"), false);
    assert.equal(existsSync(join(paperDir, "DONE")), false);
    assert.equal(
      bindEduSharePaper(state, "new-id", "http://localhost:3000/tests/new-id"),
      false,
    );
  } finally {
    rmSync(paperDir, { recursive: true, force: true });
  }
});
