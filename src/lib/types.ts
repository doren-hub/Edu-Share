export type UserRole =
  | "school_student"
  | "expert"
  | "certification"
  | "general";

export type SourceType = "school" | "expert";

export type DocumentType = "past_exam" | "paper";

/**
 * 出題セッション作成時に PDF テキスト層から解決したハイライト。
 * pdfRect は PDF ユーザー空間の軸平行矩形 [minX, minY, maxX, maxY]（pdf.js の convertToViewportRectangle にそのまま渡せる）。
 */
export type SourcePdfHighlightRect = {
  page: number;
  pdfRect: [number, number, number, number];
};

/**
 * サーバー側ハイライト解決のメタ（監査・将来のスキーマ判別用）。
 *
 * 将来の拡張候補（未実装・参考）:
 * - excerptSha256 / pdfBytesSha256: 教材差し替え・改ざん検知
 * - pdfjsWorkerVersion: テキスト層再現性
 * - llmModel / promptVersion: 出題条件のトレース
 */
export type SourcePdfHighlightMeta = {
  version: 1;
  resolvedAt: string;
  /** 実際にマッチした検索フレーズ */
  matchedPhrase?: string;
};

/**
 * 出題時に与えた教材抜粋から一字一句コピーした根拠部分（PDF 照合・網羅率に使用）。
 * sourceOriginalText はセッション作成時に同内容で固定する想定（元文の明示フィールド）。
 */
export type MultipleChoiceQuestion = {
  id: string;
  type: "multiple_choice";
  prompt: string;
  options: string[];
  correctIndex: number;
  /** NotebookLM クイズ CSV の Rationale 列（受験・結果では「解説」として表示） */
  notebookLmCsvRationale?: string;
  /** NotebookLM クイズ CSV の Hint 列（ヒント操作で表示） */
  notebookLmCsvHint?: string;
  sourceExcerpt?: string;
  /** 根拠の元文（出題時点で sourceExcerpt と同一に保存。レビュー・監査用） */
  sourceOriginalText?: string;
  /** 出題根拠（sourceExcerpt）が主に該当する PDF ページ（1 始まり）。受験 UI には出さない */
  sourcePdfPage?: number;
  /** セッション作成時に PDF から解決したマーカー座標（あれば結果画面で再照合不要） */
  sourcePdfHighlightRects?: SourcePdfHighlightRect[];
  sourcePdfHighlightMeta?: SourcePdfHighlightMeta;
};

export type EssayQuestion = {
  id: string;
  type: "essay";
  prompt: string;
  referenceAnswer?: string;
  sourceExcerpt?: string;
  sourceOriginalText?: string;
  /** 出題根拠が主に該当する PDF ページ（1 始まり）。受験 UI には出さない */
  sourcePdfPage?: number;
  sourcePdfHighlightRects?: SourcePdfHighlightRect[];
  sourcePdfHighlightMeta?: SourcePdfHighlightMeta;
};

export type StoredQuestion = MultipleChoiceQuestion | EssayQuestion;

export type ClientQuestion =
  | Omit<
      MultipleChoiceQuestion,
      | "correctIndex"
      | "sourceExcerpt"
      | "sourcePdfPage"
      | "sourceOriginalText"
      | "sourcePdfHighlightRects"
      | "sourcePdfHighlightMeta"
      /** 解説は結果画面のみ。受験 API では送らない */
      | "notebookLmCsvRationale"
    >
  | Pick<EssayQuestion, "id" | "type" | "prompt">;

export type QuizGeneration = {
  questions: StoredQuestion[];
};

export type AnswerMap = Record<string, number | string>;
