import {
  canStartNotebookLmQuizCsvPool,
  canStartNotebookLmVocabCsvPool,
} from "./notebooklm-csv.ts";

export type PaperNotebookLmMaterialPresence = {
  quiz: boolean;
  vocab: boolean;
  slide: boolean;
  video: boolean;
};

function parseMaybeJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const s = raw.trim();
  if (!s) return raw;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return raw;
  }
}

export function paperHasNotebookLmSlidePath(
  path: string | null | undefined,
): boolean {
  const p = path?.trim() ?? "";
  return /notebooklm-slide\.pdf$/i.test(p);
}

export function paperHasNotebookLmVideoPath(
  path: string | null | undefined,
): boolean {
  const p = path?.trim() ?? "";
  return /notebooklm-video\.mp4$/i.test(p);
}

export function paperNotebookLmMaterialPresence(t: {
  notebooklm_questions_json?: unknown;
  notebooklm_vocab_questions_json?: unknown;
  notebooklm_slide_pdf_storage_path?: string | null;
  notebooklm_video_mp4_storage_path?: string | null;
}): PaperNotebookLmMaterialPresence {
  const quizJson = parseMaybeJson(t.notebooklm_questions_json);
  const vocabJson = parseMaybeJson(t.notebooklm_vocab_questions_json);
  return {
    quiz: canStartNotebookLmQuizCsvPool({ notebooklm_questions_json: quizJson }),
    vocab: canStartNotebookLmVocabCsvPool({
      notebooklm_vocab_questions_json: vocabJson,
      notebooklm_questions_json: quizJson,
    }),
    slide: paperHasNotebookLmSlidePath(t.notebooklm_slide_pdf_storage_path),
    video: paperHasNotebookLmVideoPath(t.notebooklm_video_mp4_storage_path),
  };
}

export function paperNotebookLmMaterialsComplete(
  t: Parameters<typeof paperNotebookLmMaterialPresence>[0],
): boolean {
  const p = paperNotebookLmMaterialPresence(t);
  return p.quiz && p.vocab && p.slide && p.video;
}

export function paperNotebookLmMissingLabels(
  t: Parameters<typeof paperNotebookLmMaterialPresence>[0],
): { label: string }[] {
  const p = paperNotebookLmMaterialPresence(t);
  return (
    [
      { label: "クイズCSV", show: !p.quiz },
      { label: "単語帳CSV", show: !p.vocab },
      { label: "スライド", show: !p.slide },
      { label: "動画", show: !p.video },
    ] as const
  )
    .filter((x) => x.show)
    .map(({ label }) => ({ label }));
}
