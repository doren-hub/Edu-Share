import { resolvePhraseHighlightsInPdf } from "@/lib/pdf-resolve-source-highlights";
import { searchPhrasesFromPrompt, searchPhrasesFromSourceExcerpt } from "@/lib/quiz-pdf-marks";
import type { SourcePdfHighlightMeta, StoredQuestion } from "@/lib/types";

/**
 * テスト開始時に生成した設問へ、PDF から根拠箇所の矩形を付与する（questions_json に直接書き込む想定でミュータブル）。
 *
 * - sourceOriginalText: 根拠の元文（sourceExcerpt と同一内容をセッション作成時点で固定）
 * - sourcePdfHighlightRects: PDF ユーザー空間の矩形（ページ番号付き）。結果画面では再照合せずこれを優先できる。
 * - sourcePdfHighlightMeta: 解決時刻・使用フレーズ（監査・デバッグ用）
 *
 * 失敗してもセッション作成は継続する（従来どおりクライアント側照合にフォールバック）。
 */
export async function attachSourcePdfHighlightsToQuestions(
  questions: StoredQuestion[],
  pdfBuffer: Buffer,
): Promise<void> {
  for (const q of questions) {
    const ex = typeof q.sourceExcerpt === "string" ? q.sourceExcerpt.trim() : "";
    if (ex.length >= 8) {
      q.sourceOriginalText = ex;
    }

    let phrases =
      ex.length >= 12
        ? searchPhrasesFromSourceExcerpt(ex)
        : searchPhrasesFromPrompt(q.prompt);
    if (phrases.length === 0) continue;

    const hint =
      typeof q.sourcePdfPage === "number" &&
      Number.isFinite(q.sourcePdfPage) &&
      q.sourcePdfPage >= 1
        ? Math.floor(q.sourcePdfPage)
        : undefined;
    if (hint != null && ex.length >= 12) {
      phrases = phrases.slice(0, 3);
    }

    try {
      const resolved = await resolvePhraseHighlightsInPdf(pdfBuffer, phrases, hint, 60);
      if (!resolved || resolved.rects.length === 0) continue;
      q.sourcePdfHighlightRects = resolved.rects;
      const meta: SourcePdfHighlightMeta = {
        version: 1,
        resolvedAt: new Date().toISOString(),
        matchedPhrase: resolved.matchedPhrase,
      };
      q.sourcePdfHighlightMeta = meta;
    } catch {
      /* PDF 解決はベストエフォート */
    }
  }
}
