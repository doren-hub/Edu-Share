import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOtherIndustryValue,
  matchesExistingPaper,
  normalizeDoi,
  pickBestOption,
  pickPaperIndustry,
  titlesLikelySame,
  titleUsableForExistingMatch,
} from "./match.ts";

test("normalizeDoi: doi.org と裸の DOI を揃える", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1234/abc"), "10.1234/abc");
  assert.equal(normalizeDoi("doi:10.1234/abc"), "10.1234/abc");
  assert.equal(normalizeDoi("10.1234/abc."), "10.1234/abc");
});

test("titlesLikelySame: ファイル名由来の短い一致は 12 文字以上だけ", () => {
  assert.equal(
    titlesLikelySame(
      "The field equations for gravitation and electromagnetism",
      "The field equations for gravitation and electromagnetism",
    ),
    true,
  );
  assert.equal(titlesLikelySame("Short", "Something else"), false);
});

test("matchesExistingPaper: DOI 優先、なければタイトル", () => {
  const existing = [
    { title: "The field equations for gravitation and electromagnetism", doi: "10.1234/xyz" },
  ];
  assert.equal(
    matchesExistingPaper(existing, { doi: "https://doi.org/10.1234/xyz" })?.doi,
    "10.1234/xyz",
  );
  assert.ok(
    matchesExistingPaper(existing, {
      title: "The field equations for gravitation and electromagnetism",
    }),
  );
  assert.equal(matchesExistingPaper(existing, { filename: "unrelated.pdf" }), null);
});

test("titleUsableForExistingMatch: 数字ファイル名や短すぎるタイトルは使わない", () => {
  assert.equal(titleUsableForExistingMatch("1103899181", "1103899181.pdf"), false);
  assert.equal(
    titleUsableForExistingMatch(
      "A comprehensive survey of Schwarzschild's original papers: Schwarzschild's trick and Einstein's s(h)tick",
      "1103899181.pdf",
    ),
    true,
  );
});

test("pickBestOption: 最長一致", () => {
  assert.equal(
    pickBestOption(["物理", "物理化学", "生物"], "本研究は物理化学の手法を用いる"),
    "物理化学",
  );
  assert.equal(pickBestOption(["金融", "医療"], " unrelated astronomy text "), "");
});

test("pickPaperIndustry: 相対論の arXiv 論文は教育・研究", () => {
  const opts = [
    "IT・通信",
    "医療・ヘルスケア",
    "教育・研究",
    "その他",
  ];
  assert.equal(
    pickPaperIndustry(
      opts,
      "A comprehensive survey of Schwarzschild's original papers\narXiv\nThis paper examines general relativity",
    ),
    "教育・研究",
  );
});

test("pickPaperIndustry: その他は選ばない", () => {
  assert.equal(isOtherIndustryValue("その他（Home）"), true);
  assert.equal(pickPaperIndustry(["その他", "教育・研究"], "hello world"), "教育・研究");
});
