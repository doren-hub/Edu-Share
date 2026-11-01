import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCells,
  findUniqueHeaderIndex,
  extractSummarySection,
  verifySummary,
  verifyOfflineQuality,
} from "../../docs/question-quality/verify.mjs";

const VALID_SOURCE_RESULTS = [
  {
    id: "comparison",
    questionsCount: 7,
    majorDefects: 0,
    candidates: 6,
    meanRate: 85.95238095238095,
  },
  {
    id: "procedure",
    questionsCount: 7,
    majorDefects: 0,
    candidates: 2,
    meanRate: 79.76190476190476,
  },
  {
    id: "insufficient",
    questionsCount: 7,
    majorDefects: 0,
    candidates: 7,
    meanRate: 95.71428571428571,
  },
];

const VALID_SUMMARY_TEXT = `以下は [scores.json](scores.json) の整数評点から算出。重大欠陥はS/U≤1、採用候補は全適用観点≥2。

| 資料 | 問平均率 | 選択式平均率 | 記述式平均率 | S/U/D/P/L平均 | 重大欠陥 | 採用候補 | 判定 |
| --- | ---: | ---: | ---: | --- | ---: | ---: | --- |
| comparison | 85.95% | 85.33% | 87.50% | 3.00 / 2.86 / 2.29 / 2.60 / 2.14 | 0 | 6/7 | 要修正 |
| procedure | 79.76% | 80.00% | 79.17% | 3.00 / 3.00 / 2.14 / 2.20 / 1.57 | 0 | 2/7 | 要修正 |
| insufficient | 95.71% | 97.33% | 91.67% | 3.00 / 3.00 / 2.71 / 2.80 / 2.86 | 0 | 7/7 | 採用候補 |

資料を等重みで平均した全体率は **87.14%**。形式失敗は0セット、重大欠陥は0/21問、採用候補は15/21問。comparisonとprocedureは全問採用条件を満たさず要修正、insufficientはセットの採用条件を満たす。`;

test("verifyOfflineQuality executes against repository baseline files and succeeds", () => {
  const result = verifyOfflineQuality({ quiet: true });
  assert.equal(result.total, 21);
  assert.equal(result.majorDefects, 0);
  assert.equal(result.candidates, 15);
  assert.equal(result.calculatedRate, "87.14");
  assert.equal(result.sourceResults.length, 3);
});

test("parseCells correctly trims and parses pipe-delimited markdown rows", () => {
  assert.deepEqual(parseCells("| a | b | c |"), ["a", "b", "c"]);
  assert.deepEqual(parseCells("a | b | c"), ["a", "b", "c"]);
  assert.deepEqual(parseCells("|   foo   |   bar   |"), ["foo", "bar"]);
});

test("findUniqueHeaderIndex finds header index or enforces uniqueness", () => {
  const headers = ["ID", "資料", "重大欠陥", "採用候補"];
  assert.equal(findUniqueHeaderIndex(headers, "資料", ["資料", "資料ID"]), 1);
  assert.equal(findUniqueHeaderIndex(headers, "重大欠陥"), 2);
  assert.equal(findUniqueHeaderIndex(headers, "採用候補"), 3);

  // Missing
  assert.throws(
    () => findUniqueHeaderIndex(headers, "存在しない"),
    /saved summary table is missing "存在しない" header/
  );

  // Duplicate
  assert.throws(
    () => findUniqueHeaderIndex(["重大欠陥", "重大欠陥"], "重大欠陥"),
    /saved summary table has duplicate "重大欠陥" header/
  );
});

test("extractSummarySection extracts section or rejects missing section", () => {
  const md = `# Title\n\n## 集計\n\nSome summary\n\n## 読み取り\n\nNext section`;
  assert.equal(extractSummarySection(md), "\nSome summary\n");

  assert.throws(
    () => extractSummarySection("# Title\n\nNo summary section"),
    /saved summary section/
  );
});

test("verifySummary accepts valid summary text and source results", () => {
  assert.doesNotThrow(() => {
    verifySummary(VALID_SUMMARY_TEXT, VALID_SOURCE_RESULTS);
  });
});

test("verifySummary allows column reordering as long as headers are present", () => {
  // Case 1: Swap 重大欠陥 and 問平均率
  const reordered1 = VALID_SUMMARY_TEXT.replace(
    "| 資料 | 問平均率 | 選択式平均率 | 記述式平均率 | S/U/D/P/L平均 | 重大欠陥 | 採用候補 | 判定 |",
    "| 資料 | 重大欠陥 | 選択式平均率 | 記述式平均率 | S/U/D/P/L平均 | 問平均率 | 採用候補 | 判定 |"
  )
    .replace("| comparison | 85.95% |", "| comparison | 0 |")
    .replace("| 0 | 6/7 |", "| 85.95% | 6/7 |")
    .replace("| procedure | 79.76% |", "| procedure | 0 |")
    .replace("| 0 | 2/7 |", "| 79.76% | 2/7 |")
    .replace("| insufficient | 95.71% |", "| insufficient | 0 |")
    .replace("| 0 | 7/7 |", "| 95.71% | 7/7 |");

  assert.doesNotThrow(() => {
    verifySummary(reordered1, VALID_SOURCE_RESULTS);
  });

  // Case 2: 資料 column is placed second, 重大欠陥 placed first
  const reordered2 = `| 重大欠陥 | 資料 | 採用候補 |
| --- | --- | --- |
| 0 | comparison | 6/7 |
| 0 | procedure | 2/7 |
| 0 | insufficient | 7/7 |

重大欠陥は0/21問、採用候補は15/21問。全体率は **87.14%**。`;

  assert.doesNotThrow(() => {
    verifySummary(reordered2, VALID_SOURCE_RESULTS);
  });
});

test("verifySummary rejects missing or duplicate 資料 header", () => {
  // Missing 資料 header (replaced with something else)
  const missingSourceHeader = VALID_SUMMARY_TEXT.replace("| 資料 |", "| 書誌 |");
  assert.throws(
    () => verifySummary(missingSourceHeader, VALID_SOURCE_RESULTS),
    /saved summary table is missing "資料" header/
  );

  // Duplicate 資料 header
  const duplicateSourceHeader = VALID_SUMMARY_TEXT.replace(
    "| 資料 | 問平均率 |",
    "| 資料 | 資料 |"
  );
  assert.throws(
    () => verifySummary(duplicateSourceHeader, VALID_SOURCE_RESULTS),
    /saved summary table has duplicate "資料" header/
  );
});

test("verifySummary rejects missing or duplicate 重大欠陥 header", () => {
  // Missing 重大欠陥 in table header
  const missingHeader = VALID_SUMMARY_TEXT.replace("| 重大欠陥 |", "| 重大ミス |");
  assert.throws(
    () => verifySummary(missingHeader, VALID_SOURCE_RESULTS),
    /saved summary table is missing "重大欠陥" header/
  );

  // Duplicate 重大欠陥
  const duplicateHeader = VALID_SUMMARY_TEXT.replace("| 問平均率 |", "| 重大欠陥 |");
  assert.throws(
    () => verifySummary(duplicateHeader, VALID_SOURCE_RESULTS),
    /saved summary table has duplicate "重大欠陥" header/
  );
});

test("verifySummary rejects missing or duplicate 採用候補 header", () => {
  // Missing 採用候補 in table header
  const missingHeader = VALID_SUMMARY_TEXT.replace("| 採用候補 |", "| 合格問数 |");
  assert.throws(
    () => verifySummary(missingHeader, VALID_SOURCE_RESULTS),
    /saved summary table is missing "採用候補" header/
  );

  // Duplicate 採用候補
  const duplicateHeader = VALID_SUMMARY_TEXT.replace("| 問平均率 |", "| 採用候補 |");
  assert.throws(
    () => verifySummary(duplicateHeader, VALID_SOURCE_RESULTS),
    /saved summary table has duplicate "採用候補" header/
  );
});

test("verifySummary rejects rows with missing cells for required columns", () => {
  // Row truncated before candidates
  const truncatedRow = `| 資料 | 重大欠陥 | 採用候補 |
| --- | --- | --- |
| comparison | 0 |
| procedure | 0 | 2/7 |
| insufficient | 0 | 7/7 |

重大欠陥は0/21問、採用候補は15/21問。全体率は 87.14%。`;

  assert.throws(
    () => verifySummary(truncatedRow, VALID_SOURCE_RESULTS),
    /comparison: saved summary row missing "採用候補" cell/
  );
});

test("verifySummary rejects source-level value mismatches", () => {
  // comparison major defects changed from 0 to 1
  const mismatchedMajor = VALID_SUMMARY_TEXT.replace(
    "| comparison | 85.95% | 85.33% | 87.50% | 3.00 / 2.86 / 2.29 / 2.60 / 2.14 | 0 |",
    "| comparison | 85.95% | 85.33% | 87.50% | 3.00 / 2.86 / 2.29 / 2.60 / 2.14 | 1 |"
  );
  assert.throws(
    () => verifySummary(mismatchedMajor, VALID_SOURCE_RESULTS),
    /comparison: saved major defects/
  );

  // comparison candidates changed from 6/7 to 5/7
  const mismatchedCandidates = VALID_SUMMARY_TEXT.replace("| 6/7 |", "| 5/7 |");
  assert.throws(
    () => verifySummary(mismatchedCandidates, VALID_SOURCE_RESULTS),
    /comparison: saved candidates/
  );
});

test("verifySummary rejects summary text total mismatches", () => {
  // Total major defects count mismatch
  const mismatchedTotalMajor = VALID_SUMMARY_TEXT.replace(
    "重大欠陥は0/21問",
    "重大欠陥は1/21問"
  );
  assert.throws(
    () => verifySummary(mismatchedTotalMajor, VALID_SOURCE_RESULTS),
    /total saved major defects/
  );

  // Total candidates count mismatch
  const mismatchedTotalCandidates = VALID_SUMMARY_TEXT.replace(
    "採用候補は15/21問",
    "採用候補は14/21問"
  );
  assert.throws(
    () => verifySummary(mismatchedTotalCandidates, VALID_SOURCE_RESULTS),
    /total saved candidates/
  );

  // Total questions count mismatch
  const mismatchedTotalQuestions = VALID_SUMMARY_TEXT.replace(
    "重大欠陥は0/21問",
    "重大欠陥は0/20問"
  );
  assert.throws(
    () => verifySummary(mismatchedTotalQuestions, VALID_SOURCE_RESULTS),
    /total saved questions/
  );

  // Overall rate mismatch
  const mismatchedRate = VALID_SUMMARY_TEXT.replace("87.14%", "88.00%");
  assert.throws(
    () => verifySummary(mismatchedRate, VALID_SOURCE_RESULTS),
    /total saved overall rate/
  );
});

test("verifySummary rejects summary table without matching source row", () => {
  const missingRow = `| 資料 | 重大欠陥 | 採用候補 |
| --- | --- | --- |
| comparison | 0 | 6/7 |
| procedure | 0 | 2/7 |

重大欠陥は0/21問、採用候補は15/21問。全体率は 87.14%。`;

  assert.throws(
    () => verifySummary(missingRow, VALID_SOURCE_RESULTS),
    /insufficient: saved summary row/
  );
});
