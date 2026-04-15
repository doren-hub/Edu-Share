import type { QuestionPerformanceRow } from "@/lib/question-performance";

/** 設問パフォーマンス行から全体の正答率（加重なし） */
export function aggregateCorrectRatePercent(
  rows: QuestionPerformanceRow[],
): number | null {
  let attempts = 0;
  let correct = 0;
  for (const r of rows) {
    attempts += r.attempts;
    correct += r.correct_count;
  }
  if (attempts <= 0) return null;
  return Math.round((100 * correct) / attempts);
}

export type UnderstandingBand = "high" | "mid" | "low" | "weak";

export type UnderstandingDisplay = {
  /** 0〜100。算出できないとき null */
  score: number | null;
  band: UnderstandingBand | null;
  /** 見出し用の短いラベル */
  headline: string;
  /** 内訳の説明（日本語） */
  formulaNote: string;
  coveragePercent: number | null;
  correctRatePercent: number | null;
  /** UI の dt 文言（未指定時は UnderstandingSection の既定） */
  coverageStatLabel?: string;
  correctStatLabel?: string;
  /** 設定時は dd にパーセントではなくこの文字列を表示（CSV: 問題数／回答数） */
  coverageValueDisplay?: string;
};

function bandFromScore(score: number): UnderstandingBand {
  if (score >= 72) return "high";
  if (score >= 52) return "mid";
  if (score >= 34) return "low";
  return "weak";
}

function bandHeadline(band: UnderstandingBand): string {
  switch (band) {
    case "high":
      return "理解が深い傾向です";
    case "mid":
      return "着実に身についています";
    case "low":
      return "復習で伸ばせそうです";
    default:
      return "基礎の確認をおすすめします";
  }
}

/**
 * 論文では網羅率×正答率（÷100）、過去問などでは正答率のみで理解度（0〜100）を返す。
 * 網羅率は「PDF チャンクが、保存した根拠抜粋（旧データは設問文）に触れている割合」、正答率は提出ベースの目安です。
 */
export function computeUnderstandingDisplay(params: {
  isPaper: boolean;
  /** 論文のみ。チャンク未作成などで null */
  coveragePercent: number | null;
  /** question_performance の集計。未提出・未集計なら null */
  correctRatePercent: number | null;
}): UnderstandingDisplay {
  const coverage = params.isPaper ? params.coveragePercent : null;
  const correct = params.correctRatePercent;

  if (coverage != null && correct != null) {
    const score = Math.min(100, Math.round((coverage * correct) / 100));
    const band = bandFromScore(score);
    return {
      score,
      band,
      headline: bandHeadline(band),
      formulaNote:
        "論文では「網羅率（%）× 設問の正答率（%）÷ 100」を理解度としています。どちらかが低いと全体も下がります（いずれも目安）。",
      coveragePercent: coverage,
      correctRatePercent: correct,
    };
  }

  if (correct != null) {
    const band = bandFromScore(correct);
    return {
      score: correct,
      band,
      headline: bandHeadline(band),
      formulaNote:
        params.isPaper && coverage == null
          ? "網羅率は算出できていないため、設問の正答率のみで表示しています。"
          : "設問全体の正答率のみで表示しています。",
      coveragePercent: coverage,
      correctRatePercent: correct,
    };
  }

  if (coverage != null) {
    const band = bandFromScore(coverage);
    return {
      score: coverage,
      band,
      headline: bandHeadline(band),
      formulaNote:
        "テストの正答データがまだないため、網羅率のみで表示しています。提出が溜まると正答率も反映されます。",
      coveragePercent: coverage,
      correctRatePercent: null,
    };
  }

  return {
    score: null,
    band: null,
    headline: "データがまだ不足しています",
    formulaNote:
      "テストを受けて提出すると正答率が入ります。論文では網羅率と正答率の積で表示されます。",
    coveragePercent: coverage,
    correctRatePercent: null,
  };
}

const CSV_COVERAGE_DT = "問題数／回答数";
const CSV_CORR_LABEL = "正答率";

/**
 * NotebookLM CSV 用: プール問題数と回答（試行）回数を示し、それらから得た比率×正答率で理解度（積÷100）を返す。
 */
export function computeCsvPoolUnderstandingDisplay(params: {
  /** UI 用の短い名前（例: クイズ CSV） */
  poolTitle: string;
  poolSize: number;
  rows: QuestionPerformanceRow[];
}): UnderstandingDisplay {
  const statBase = {
    coverageStatLabel: CSV_COVERAGE_DT,
    correctStatLabel: CSV_CORR_LABEL,
  };

  if (params.poolSize <= 0) {
    return {
      score: null,
      band: null,
      headline: "プール未設定",
      formulaNote: `${params.poolTitle} の設問プールが無いか、まだ CSV が登録されていません。`,
      coveragePercent: null,
      correctRatePercent: null,
      coverageValueDisplay: "—／—",
      ...statBase,
    };
  }

  let attempts = 0;
  let correct = 0;
  for (const r of params.rows) {
    attempts += r.attempts;
    correct += r.correct_count;
  }

  const ratioDisplay = `${params.poolSize}／${attempts}`;

  const correctRatePercent =
    attempts > 0 ? Math.round((100 * correct) / attempts) : null;
  const coveragePercent =
    attempts > 0
      ? Math.min(100, Math.round((100 * attempts) / params.poolSize))
      : 0;

  if (correctRatePercent != null && coveragePercent != null) {
    const score = Math.min(100, Math.round((coveragePercent * correctRatePercent) / 100));
    const band = bandFromScore(score);
    return {
      score,
      band,
      headline: bandHeadline(band),
      formulaNote: `${params.poolTitle}: 問題数／回答数はプール問数と試行回数。理解度は（試行÷問題数を100で上限）×正答率÷100 の目安です。`,
      coveragePercent,
      correctRatePercent,
      coverageValueDisplay: ratioDisplay,
      ...statBase,
    };
  }

  if (coveragePercent != null) {
    const band = bandFromScore(coveragePercent);
    return {
      score: coveragePercent,
      band,
      headline: bandHeadline(band),
      formulaNote: `${params.poolTitle}: 正答の集計がまだ無いため、正答率は「—」。問題数／回答数のみ反映しています。`,
      coveragePercent,
      correctRatePercent: null,
      coverageValueDisplay: ratioDisplay,
      ...statBase,
    };
  }

  return {
    score: null,
    band: null,
    headline: "データがまだ不足しています",
    formulaNote: `${params.poolTitle}・プール ${params.poolSize} 問。提出後に集計されます。`,
    coveragePercent: null,
    correctRatePercent: null,
    coverageValueDisplay: ratioDisplay,
    ...statBase,
  };
}
