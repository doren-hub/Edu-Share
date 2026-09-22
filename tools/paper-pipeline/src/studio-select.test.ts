import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv } from "./config.ts";
import { listStudioFollowupPdfs, listWorkPdfs } from "./inbox.ts";
import {
  formatStudioGenerateArg,
  parseStudioGenerateTokens,
  skipStudioStages,
} from "./studio-select.ts";

test("parseStudioGenerateTokens: 空と all は 4 種", () => {
  assert.deepEqual(parseStudioGenerateTokens([]), [
    "nlm-slides",
    "nlm-video",
    "nlm-quiz",
    "nlm-flashcards",
  ]);
  assert.deepEqual(parseStudioGenerateTokens(["all"]), [
    "nlm-slides",
    "nlm-video",
    "nlm-quiz",
    "nlm-flashcards",
  ]);
  assert.deepEqual(parseStudioGenerateTokens(["ALL", "quiz"]), [
    "nlm-slides",
    "nlm-video",
    "nlm-quiz",
    "nlm-flashcards",
  ]);
});

test("parseStudioGenerateTokens: 複数選択", () => {
  assert.deepEqual(parseStudioGenerateTokens(["slides", "quiz"]), ["nlm-slides", "nlm-quiz"]);
  assert.deepEqual(parseStudioGenerateTokens(["video", "flashcards"]), [
    "nlm-video",
    "nlm-flashcards",
  ]);
  assert.throws(() => parseStudioGenerateTokens(["スライド"]), /不明な --generate/);
});

test("parseStudioGenerateTokens: 不明な値はエラー", () => {
  assert.throws(() => parseStudioGenerateTokens(["audio"]), /不明な --generate/);
});

test("skipStudioStages / formatStudioGenerateArg", () => {
  assert.deepEqual(skipStudioStages(["nlm-quiz"]), [
    "nlm-slides",
    "nlm-video",
    "nlm-flashcards",
  ]);
  assert.equal(formatStudioGenerateArg(["nlm-slides", "nlm-video"]), "slides,video");
  assert.equal(formatStudioGenerateArg(parseStudioGenerateTokens(["all"])), "all");
});

test("parseArgv: --generate は繰り返しとカンマ区切り", () => {
  const a = parseArgv(["--generate", "slides,quiz", "--generate", "video"]);
  assert.deepEqual(a.generate, ["slides", "quiz", "video"]);
});

test("parseArgv: --newest-first", () => {
  assert.equal(parseArgv(["--newest-first"]).newestFirst, true);
  assert.equal(parseArgv([]).newestFirst, undefined);
});

test("listWorkPdfs: --only で作業フォルダの PDF を拾う", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-work-only-"));
  const work = join(root, "work");
  const paperDir = join(work, "hawk");
  mkdirSync(paperDir, { recursive: true });
  try {
    writeFileSync(join(paperDir, "hawking.pdf"), "pdf");
    writeFileSync(
      join(paperDir, "state.json"),
      JSON.stringify({
        filename: "hawking.pdf",
        inboxPdfPath: join(paperDir, "hawking.pdf"),
        paperDir,
        completed: ["done"],
        eduShareTestId: "uuid-1",
        eduShareTestUrl: "http://localhost:3000/tests/uuid-1",
      }),
    );
    writeFileSync(join(paperDir, "DONE"), "ok\n");
    assert.deepEqual(listWorkPdfs(work, "hawking.pdf").map((p) => p.filename), ["hawking.pdf"]);
    assert.deepEqual(listWorkPdfs(work, ""), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listStudioFollowupPdfs: Edu Share 済みでクイズ CSV が無い論文", () => {
  const root = mkdtempSync(join(tmpdir(), "paper-followup-"));
  const work = join(root, "work");
  const paperDir = join(work, "0709");
  mkdirSync(paperDir, { recursive: true });
  try {
    writeFileSync(join(paperDir, "0709.pdf"), "pdf");
    writeFileSync(join(paperDir, "slides.pdf"), "x".repeat(2000));
    writeFileSync(
      join(paperDir, "state.json"),
      JSON.stringify({
        filename: "0709.pdf",
        inboxPdfPath: join(paperDir, "0709.pdf"),
        paperDir,
        completed: ["nlm-slides", "done"],
        eduShareTestId: "uuid-2",
        slidePdfPath: join(paperDir, "slides.pdf"),
        quizCsvPath: "",
      }),
    );
    writeFileSync(join(paperDir, "DONE"), "ok\n");
    const quizOnly = listStudioFollowupPdfs(work, ["nlm-quiz"]);
    assert.deepEqual(quizOnly.map((p) => p.filename), ["0709.pdf"]);
    const slidesOnly = listStudioFollowupPdfs(work, ["nlm-slides"]);
    assert.deepEqual(slidesOnly.map((p) => p.filename), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
