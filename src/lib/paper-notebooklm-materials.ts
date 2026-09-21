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

export type PaperNotebookLmMaterialInput = {
  notebooklm_questions_json?: unknown;
  notebooklm_vocab_questions_json?: unknown;
  notebooklm_has_quiz_csv?: boolean;
  notebooklm_has_vocab_csv?: boolean;
  notebooklm_slide_pdf_storage_path?: string | null;
  notebooklm_video_mp4_storage_path?: string | null;
};

export function paperNotebookLmMaterialPresence(
  t: PaperNotebookLmMaterialInput,
): PaperNotebookLmMaterialPresence {
  const quizJson = parseMaybeJson(t.notebooklm_questions_json);
  const vocabJson = parseMaybeJson(t.notebooklm_vocab_questions_json);
  return {
    quiz:
      typeof t.notebooklm_has_quiz_csv === "boolean"
        ? t.notebooklm_has_quiz_csv
        : canStartNotebookLmQuizCsvPool({ notebooklm_questions_json: quizJson }),
    vocab:
      typeof t.notebooklm_has_vocab_csv === "boolean"
        ? t.notebooklm_has_vocab_csv
        : canStartNotebookLmVocabCsvPool({
            notebooklm_vocab_questions_json: vocabJson,
            notebooklm_questions_json: quizJson,
          }),
    slide: paperHasNotebookLmSlidePath(t.notebooklm_slide_pdf_storage_path),
    video: paperHasNotebookLmVideoPath(t.notebooklm_video_mp4_storage_path),
  };
}

function jsonPoolFromBrowseRow(
  row: Record<string, unknown>,
  full: unknown,
  prefix: "nq" | "nv",
): unknown {
  if (full != null) return parseMaybeJson(full);
  const items = [row[`${prefix}0`], row[`${prefix}1`], row[`${prefix}2`]].filter(
    (x) => x != null && x !== "",
  );
  return items.length ? items : null;
}

/** 一覧用: 件数判定だけ残し、巨大な questions JSON はクライアントへ渡さない */
export function toPaperBrowseListRow<T extends Record<string, unknown>>(row: T) {
  const {
    notebooklm_questions_json,
    notebooklm_vocab_questions_json,
    pdf_storage_path: _pdfStoragePath,
    uploaded_by: _uploadedBy,
    nq0: _nq0,
    nq1: _nq1,
    nq2: _nq2,
    nv0: _nv0,
    nv1: _nv1,
    nv2: _nv2,
    ...rest
  } = row as T & {
    notebooklm_questions_json?: unknown;
    notebooklm_vocab_questions_json?: unknown;
    pdf_storage_path?: unknown;
    uploaded_by?: unknown;
    nq0?: unknown;
    nq1?: unknown;
    nq2?: unknown;
    nv0?: unknown;
    nv1?: unknown;
    nv2?: unknown;
  };
  const quizJson = jsonPoolFromBrowseRow(
    row,
    notebooklm_questions_json,
    "nq",
  );
  const vocabJson = jsonPoolFromBrowseRow(
    row,
    notebooklm_vocab_questions_json,
    "nv",
  );
  return {
    ...rest,
    notebooklm_has_quiz_csv: canStartNotebookLmQuizCsvPool({
      notebooklm_questions_json: quizJson,
    }),
    notebooklm_has_vocab_csv: canStartNotebookLmVocabCsvPool({
      notebooklm_vocab_questions_json: vocabJson,
      notebooklm_questions_json: quizJson,
    }),
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
