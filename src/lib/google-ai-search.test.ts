import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleAiSearchQueryText,
  buildGoogleAiSearchUrl,
  DEFAULT_MAX_QUERY_LENGTH,
} from "./google-ai-search.ts";

test("質問が空（または空白のみ）のときは、タイトルだけで開く", () => {
  // 質問なし
  assert.equal(
    buildGoogleAiSearchQueryText({ title: "Attention Is All You Need" }),
    "Attention Is All You Need",
  );

  // 質問が空文字列
  assert.equal(
    buildGoogleAiSearchQueryText({
      title: "Attention Is All You Need",
      question: "",
    }),
    "Attention Is All You Need",
  );

  // 質問が空白のみ
  assert.equal(
    buildGoogleAiSearchQueryText({
      title: "Attention Is All You Need",
      question: "   \t\n  ",
    }),
    "Attention Is All You Need",
  );

  // DOI があっても質問が空ならタイトルだけ
  assert.equal(
    buildGoogleAiSearchQueryText({
      title: "Attention Is All You Need",
      doi: "10.48550/arXiv.1706.03762",
      question: "   ",
    }),
    "Attention Is All You Need",
  );
});

test("質問があるときは、タイトルと質問文を組み合わせる", () => {
  assert.equal(
    buildGoogleAiSearchQueryText({
      title: "Attention Is All You Need",
      question: "Transformerの計算量はどのくらいですか？",
    }),
    "Attention Is All You Need Transformerの計算量はどのくらいですか？",
  );
});

test("DOI があるときは、タイトル・DOI・質問文を組み合わせる", () => {
  assert.equal(
    buildGoogleAiSearchQueryText({
      title: "Attention Is All You Need",
      doi: "10.48550/arXiv.1706.03762",
      question: "Transformerの計算量はどのくらいですか？",
    }),
    "Attention Is All You Need (DOI: 10.48550/arXiv.1706.03762) Transformerの計算量はどのくらいですか？",
  );

  // DOI に https://doi.org/ や doi: の接頭辞があっても正規化される
  assert.equal(
    buildGoogleAiSearchQueryText({
      title: "Attention Is All You Need",
      doi: "https://doi.org/10.48550/arXiv.1706.03762",
      question: "Transformerの計算量はどのくらいですか？",
    }),
    "Attention Is All You Need (DOI: 10.48550/arXiv.1706.03762) Transformerの計算量はどのくらいですか？",
  );
});

test("タイトルや質問の前後の余分な空白は trim される", () => {
  assert.equal(
    buildGoogleAiSearchQueryText({
      title: "  Deep Residual Learning   ",
      doi: " 10.1109/CVPR.2016.90 ",
      question: "  ResNetのスキップ接続とは？  ",
    }),
    "Deep Residual Learning (DOI: 10.1109/CVPR.2016.90) ResNetのスキップ接続とは？",
  );
});

test("長すぎる文面は指定された最大文字数で切り詰められる", () => {
  const longQuestion = "a".repeat(1500);
  const result = buildGoogleAiSearchQueryText(
    {
      title: "Short Title",
      question: longQuestion,
    },
    { maxLength: 50 },
  );

  assert.equal(result.length, 50);
  assert.equal(result.startsWith("Short Title aaaaa"), true);
});

test("サロゲートペアの境界で切り詰める際に上位サロゲートを孤立させない", () => {
  // 𠮷 はサロゲートペア（2文字分）
  const textWithSurrogate = "タイトル𠮷野家";
  const result = buildGoogleAiSearchQueryText(
    {
      title: textWithSurrogate,
      question: "詳細",
    },
    { maxLength: 5 }, // "タイトル" (4文字) + 𠮷の上位サロゲート(1文字) でちょうど壊れる位置
  );

  assert.equal(result, "タイトル");
  assert.equal(result.length, 4);
});

test("buildGoogleAiSearchUrl: Google AI モード（udm=50）の URL を生成し、文面をエンコードする", () => {
  const urlString = buildGoogleAiSearchUrl({
    title: "Attention Is All You Need",
    doi: "10.48550/arXiv.1706.03762",
    question: "関連する最新研究は？",
  });

  const parsed = new URL(urlString);
  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.hostname, "www.google.com");
  assert.equal(parsed.pathname, "/search");
  assert.equal(parsed.searchParams.get("udm"), "50");
  assert.equal(
    parsed.searchParams.get("q"),
    "Attention Is All You Need (DOI: 10.48550/arXiv.1706.03762) 関連する最新研究は？",
  );
});

test("buildGoogleAiSearchUrl: 質問が空のときはタイトルのみで検索 URL を生成する", () => {
  const urlString = buildGoogleAiSearchUrl({
    title: "Attention Is All You Need",
  });

  const parsed = new URL(urlString);
  assert.equal(parsed.searchParams.get("udm"), "50");
  assert.equal(parsed.searchParams.get("q"), "Attention Is All You Need");
});

test("本文やユーザー情報などの不要な項目は一切渡されない", () => {
  // 不用意な余分プロパティを持つオブジェクトが渡されても、クエリには入らない
  const extraPayload = {
    title: "Paper Title",
    doi: "10.1234/test",
    question: "質問内容",
    content: "論文本文の極秘テキスト",
    abstract: "アブストラクトの全文",
    notes: "著者の非公開メモ",
    user_id: "user_secret_uuid",
    email: "user@example.com",
  };

  const url = buildGoogleAiSearchUrl(extraPayload);
  assert.equal(url.includes("論文本文"), false);
  assert.equal(url.includes("アブストラクト"), false);
  assert.equal(url.includes("非公開メモ"), false);
  assert.equal(url.includes("user_secret_uuid"), false);
  assert.equal(url.includes("user@example.com"), false);
});
