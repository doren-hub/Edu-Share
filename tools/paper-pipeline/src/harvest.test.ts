import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, type PaperState } from "./state.ts";
import {
  hasAnyStudioArtifact,
  hasHarvestableWork,
  hasPendingStudioHarvest,
  missingEduUploads,
  shouldSkipNotebookVisit,
} from "./harvest.ts";
import { STUDIO_STAGES } from "./state.ts";

function paper(dir: string, partial: Partial<PaperState> = {}): PaperState {
  return {
    ...emptyState({
      filename: "a.pdf",
      inboxPdfPath: join(dir, "a.pdf"),
      paperDir: dir,
    }),
    ...partial,
  };
}

test("hasAnyStudioArtifact: 1種でもファイルがあれば真", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-harvest-"));
  const empty = mkdtempSync(join(tmpdir(), "pp-harvest-empty-"));
  try {
    writeFileSync(join(dir, "quiz.csv"), "question,answer\nWhat is it?,A fact.\n");
    const state = paper(dir, { quizCsvPath: join(dir, "quiz.csv") });
    assert.equal(hasAnyStudioArtifact(state, STUDIO_STAGES), true);
    assert.equal(hasAnyStudioArtifact(paper(empty), STUDIO_STAGES), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("hasHarvestableWork: SciSpace 未掲載は利用量待ちでも進める", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-harvest-"));
  try {
    assert.equal(hasHarvestableWork(paper(dir), STUDIO_STAGES), true);
    assert.equal(
      hasHarvestableWork(
        paper(dir, {
          completed: ["sci-upload", "sci-meta"],
          filesPaste: "a.pdf\nA title\n2024 · Ada Lovelace\narXiv",
        }),
        STUDIO_STAGES,
      ),
      false,
    );
    assert.equal(
      hasHarvestableWork(paper(dir, { completed: ["sci-upload", "sci-meta"] }), STUDIO_STAGES),
      true,
    );
    assert.equal(
      hasHarvestableWork(
        paper(dir, {
          filename: "2307.09009v3.pdf",
          completed: ["sci-upload", "sci-meta", "edu-upload", "done"],
          eduShareTestUrl: "http://localhost:3000/tests/x",
          filesPaste:
            "The First Law of Robotics Revisited: A New Perspective on Autonomous Systems\n2024⋅DOI⋅A. K. Dewdney",
        }),
        STUDIO_STAGES,
      ),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasHarvestableWork: 生成物が1つあれば Edu Share へ載せられる", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-harvest-"));
  try {
    writeFileSync(join(dir, "slides.pdf"), "x".repeat(2000));
    const state = paper(dir, {
      completed: ["sci-upload", "sci-meta", "nlm-slides"],
      slidePdfPath: join(dir, "slides.pdf"),
      filesPaste: "a.pdf\nA title\n2024 · Ada Lovelace\narXiv",
    });
    assert.equal(hasHarvestableWork(state, STUDIO_STAGES), true);
    assert.deepEqual(missingEduUploads(state, STUDIO_STAGES), ["nlm-slides"]);
    state.eduShareTestId = "uuid";
    state.eduShareTestUrl = "http://localhost:3000/tests/uuid";
    state.completed.push("edu-upload");
    state.eduUploaded = ["nlm-slides"];
    assert.equal(hasHarvestableWork(state, STUDIO_STAGES), true);
    state.completed.push("verify");
    assert.equal(hasHarvestableWork(state, STUDIO_STAGES), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasHarvestableWork: 解説動画はあるが MP4 が無いなら Studio から取る", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-harvest-mp4-"));
  try {
    writeFileSync(join(dir, "slides.pdf"), "x".repeat(2000));
    writeFileSync(join(dir, "quiz.csv"), "question,answer\nWhat is it?,A fact.\n");
    writeFileSync(join(dir, "vocab.csv"), "term,definition\nA,B\n");
    const state = paper(dir, {
      notebooklmUrl: "https://notebooklm.google.com/notebook/x",
      completed: [
        "sci-upload",
        "sci-meta",
        "edu-upload",
        "nlm-slides",
        "nlm-quiz",
        "nlm-flashcards",
        "nlm-video",
      ],
      studioStarted: ["nlm-quiz", "nlm-flashcards", "nlm-video"],
      eduUploaded: ["nlm-quiz", "nlm-flashcards", "nlm-slides"],
      filesPaste: "a.pdf\nA title\n2024 · Ada Lovelace\narXiv",
      eduShareTestUrl: "http://localhost:3000/tests/x",
      slidePdfPath: join(dir, "slides.pdf"),
      quizCsvPath: join(dir, "quiz.csv"),
      vocabCsvPath: join(dir, "vocab.csv"),
    });
    assert.equal(hasHarvestableWork(state, STUDIO_STAGES), true);
    assert.equal(shouldSkipNotebookVisit(state, STUDIO_STAGES), false);
    assert.equal(shouldSkipNotebookVisit(state, STUDIO_STAGES, { skipStudio: true }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("shouldSkipNotebookVisit: メタ未取得や Chrome 切断後は Studio を開かない", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-harvest-skip-"));
  try {
    const settled = paper(dir, {
      completed: ["sci-upload", "nlm-create", "nlm-upload", "nlm-slides", "nlm-quiz", "nlm-flashcards"],
      studioStarted: ["nlm-slides", "nlm-video", "nlm-quiz", "nlm-flashcards"],
    });
    assert.equal(shouldSkipNotebookVisit(settled, STUDIO_STAGES), true);
    const allDone = paper(dir, {
      completed: [
        "sci-upload",
        "sci-meta",
        "nlm-create",
        "nlm-upload",
        "nlm-slides",
        "nlm-video",
        "nlm-quiz",
        "nlm-flashcards",
      ],
      filesPaste: "a.pdf\nA title\n2024 · Ada Lovelace\narXiv",
    });
    assert.equal(shouldSkipNotebookVisit(allDone, STUDIO_STAGES), true);
    const unsettled = paper(dir, {
      completed: ["sci-upload", "nlm-create", "nlm-upload", "nlm-slides"],
      studioStarted: ["nlm-slides", "nlm-quiz"],
    });
    assert.equal(shouldSkipNotebookVisit(unsettled, STUDIO_STAGES), false);
    assert.equal(shouldSkipNotebookVisit(unsettled, STUDIO_STAGES, { skipStudio: true }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasHarvestableWork: 収穫クールダウン中は同じ MP4 / メタ取り直しを収穫扱いにしない", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-harvest-cool-"));
  try {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const state = paper(dir, {
      notebooklmUrl: "https://notebooklm.google.com/notebook/x",
      completed: ["sci-upload", "sci-meta", "edu-upload", "nlm-slides", "nlm-video"],
      studioStarted: ["nlm-slides", "nlm-video"],
      harvestRetryAt: until,
      harvestFailures: 1,
      filesPaste: "a.pdf\nA title\n2024 · Ada Lovelace\narXiv",
      eduShareTestUrl: "http://localhost:3000/tests/x",
      waitingFor: "nlm-video",
    });
    assert.equal(hasHarvestableWork(state, STUDIO_STAGES), false);
    assert.equal(shouldSkipNotebookVisit(state, STUDIO_STAGES), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasPendingStudioHarvest: SciSpace クールダウン中でも NotebookLM 収穫を優先", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-harvest-studio-"));
  try {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const state = paper(dir, {
      notebooklmUrl: "https://notebooklm.google.com/notebook/x",
      completed: ["sci-upload", "sci-meta", "edu-upload", "nlm-slides", "nlm-video", "edu-materials", "verify"],
      studioStarted: ["nlm-slides", "nlm-video", "nlm-quiz", "nlm-flashcards"],
      harvestRetryAt: until,
      harvestFailures: 1,
      filesPaste: "a.pdf\nA title\n2024 · Ada\nvol. 98",
      eduShareTestUrl: "http://localhost:3000/tests/x",
      waitingFor: "nlm-quiz",
    });
    assert.equal(hasPendingStudioHarvest(state, STUDIO_STAGES), true);
    assert.equal(hasHarvestableWork(state, STUDIO_STAGES), true);
    assert.equal(shouldSkipNotebookVisit(state, STUDIO_STAGES), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
