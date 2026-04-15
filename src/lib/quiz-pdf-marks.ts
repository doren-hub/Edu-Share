import type { AnswerMap, SourcePdfHighlightRect, StoredQuestion } from "@/lib/types";
import { essayScoreFromFeedback } from "@/lib/question-performance";

const ESSAY_PASS = 6;

export type PdfMarkItem = {
  correct: boolean;
  /** PDF 本文照合用。長い順に試す（sourceExcerpt は原文に寄せ、他箇所への誤マッチを抑える） */
  phrases: string[];
  /** 出題時に記録した根拠ページ（1 始まり）。あるときはこのページだけでマーカーを付ける */
  pdfPageHint?: number;
  /** 重複キー用（同一座標の別設問を区別） */
  questionId?: string;
  /** セッション作成時にサーバーで解決した矩形（あればブラウザはテキスト照合をスキップ） */
  pdfHighlightRects?: SourcePdfHighlightRect[];
};

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 設問プロンプトから PDF 検索用の断片を複数作る（旧データ向け） */
export function searchPhrasesFromPrompt(prompt: string): string[] {
  return searchPhrasesForPdfMatch(prompt, { maxSlice: 72 });
}

/** 出題根拠の連続原文を 1 本に近い形で PDF に当てる（短い窓は他段落と重複しやすいので使わない） */
const SOURCE_PHRASE_MIN = 8;
const SOURCE_PHRASE_MAX = 240;

/**
 * 出題時に保存した教材抜粋（PDF 原文）から PDF テキスト層照合用の断片を作る。
 * 抜粋の先頭からの長い連続一致のみを候補にし、本文中の別の重複箇所にマーカーが乗りにくくする。
 */
export function searchPhrasesFromSourceExcerpt(excerpt: string): string[] {
  const t = norm(excerpt);
  if (t.length < SOURCE_PHRASE_MIN) return [];
  const out: string[] = [];
  if (t.length <= SOURCE_PHRASE_MAX) {
    out.push(t);
  } else {
    out.push(t.slice(0, SOURCE_PHRASE_MAX));
    for (let cut = 48; cut <= SOURCE_PHRASE_MAX - 72 && out.length < 8; cut += 48) {
      out.push(t.slice(0, SOURCE_PHRASE_MAX - cut));
    }
  }
  const uniq = [...new Set(out.filter((s) => s.length >= SOURCE_PHRASE_MIN))];
  uniq.sort((a, b) => b.length - a.length);
  return uniq;
}

function searchPhrasesForPdfMatch(
  text: string,
  opts: { maxSlice: number },
): string[] {
  const t = norm(text);
  if (t.length < 8) return [];
  const out: string[] = [];
  const max = opts.maxSlice;
  const push = (a: number, b: number) => {
    const s = t.slice(a, b).trim();
    if (s.length >= 8 && s.length <= max) out.push(s);
  };
  push(0, Math.min(max, t.length));
  if (t.length > 20) push(12, Math.min(12 + max, t.length));
  if (t.length > 40) push(28, Math.min(28 + max, t.length));
  if (t.length > max * 2) {
    const mid = Math.floor(t.length / 2);
    push(mid, Math.min(mid + max - 8, t.length));
  }
  const step = Math.max(10, Math.floor(max / 2));
  for (let a = 0; a + 8 <= t.length && out.length < 12; a += step) {
    push(a, Math.min(a + Math.min(36, max), t.length));
  }
  const uniq = [...new Set(out)];
  uniq.sort((a, b) => b.length - a.length);
  return uniq;
}

export function buildPdfMarkItems(params: {
  questions: unknown;
  answers: unknown;
  feedback: unknown;
}): PdfMarkItem[] {
  const qj = params.questions;
  if (!Array.isArray(qj)) return [];

  const answers = (params.answers ?? {}) as AnswerMap;
  const out: PdfMarkItem[] = [];

  for (const raw of qj) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as StoredQuestion;
    if (typeof q.id !== "string" || typeof q.prompt !== "string") continue;
    const ex =
      typeof q.sourceExcerpt === "string" ? q.sourceExcerpt.trim() : "";
    const pdfPageHint =
      typeof q.sourcePdfPage === "number" &&
      Number.isFinite(q.sourcePdfPage) &&
      q.sourcePdfPage >= 1
        ? Math.floor(q.sourcePdfPage)
        : undefined;
    let phrases =
      ex.length >= 12
        ? searchPhrasesFromSourceExcerpt(ex)
        : searchPhrasesFromPrompt(q.prompt);
    if (phrases.length === 0) continue;
    if (pdfPageHint != null && ex.length >= 12) {
      phrases = phrases.slice(0, 3);
    }

    let correct = false;
    if (q.type === "multiple_choice") {
      const a = answers[q.id];
      correct = typeof a === "number" && a === q.correctIndex;
    } else if (q.type === "essay") {
      const s = essayScoreFromFeedback(params.feedback, q.id);
      correct = s !== null && s >= ESSAY_PASS;
    } else continue;

    out.push({
      correct,
      phrases,
      pdfPageHint,
      questionId: q.id,
      pdfHighlightRects: q.sourcePdfHighlightRects,
    });
  }
  return out;
}
