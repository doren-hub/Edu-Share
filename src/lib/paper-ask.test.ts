import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type PaperAskChunk,
  selectPaperAskChunks,
  buildPaperAskPrompt,
  parsePaperAskResponse,
  askPaperQuestion,
} from "./paper-ask.ts";
import {
  checkUserAskRateLimit,
  resetUserAskRateLimitForTests,
  ASK_RATE_LIMIT_MAX_REQUESTS,
} from "./paper-ask-rate-limit.ts";

describe("selectPaperAskChunks: 材料の選び方", () => {
  const sampleChunks: PaperAskChunk[] = [
    { id: "c1", chunk_index: 0, content: "チャンク1の内容です。".repeat(10), pdf_page: 1 },
    { id: "c2", chunk_index: 1, content: "チャンク2の内容です。".repeat(10), pdf_page: 2 },
    { id: "c3", chunk_index: 2, content: "チャンク3の内容です。".repeat(10), pdf_page: 3 },
  ];

  it("本文の合計が上限以下のときは全チャンクをそのまま渡す (mode: 'all')", () => {
    const res = selectPaperAskChunks({
      allChunks: sampleChunks,
      maxChars: 5000,
    });
    assert.equal(res.mode, "all");
    assert.equal(res.chunks.length, 3);
    assert.equal(res.chunks[0]!.id, "c1");
    assert.equal(res.chunks[2]!.id, "c3");
    assert.equal(res.notice, undefined);
  });

  it("上限を超え、埋め込みがあるときは近いチャンクを選ぶ (mode: 'embedding')", () => {
    // 1チャンク約100文字。maxChars: 150 のとき、上位チャンクを容量まで選ぶ
    const matchedChunks: PaperAskChunk[] = [
      sampleChunks[2]!, // c3 (similarity 高い)
      sampleChunks[0]!, // c1
    ];
    const res = selectPaperAskChunks({
      allChunks: sampleChunks,
      maxChars: 150,
      hasEmbeddings: true,
      matchedChunks,
    });
    assert.equal(res.mode, "embedding");
    assert.equal(res.chunks.length, 1);
    assert.equal(res.chunks[0]!.id, "c3");
    assert.equal(res.notice, undefined);
  });

  it("埋め込み検索結果を chunk_index 順（論文の読み順）に整列する", () => {
    const matchedChunks: PaperAskChunk[] = [
      sampleChunks[2]!, // c3
      sampleChunks[0]!, // c1
    ];
    const res = selectPaperAskChunks({
      allChunks: sampleChunks,
      maxChars: 300,
      hasEmbeddings: true,
      matchedChunks,
    });
    assert.equal(res.mode, "embedding");
    assert.equal(res.chunks.length, 2);
    assert.equal(res.chunks[0]!.id, "c1");
    assert.equal(res.chunks[1]!.id, "c3");
  });

  it("上限を超え、埋め込みがないときは先頭から上限まで渡し、注意書きを設定する (mode: 'head_truncated')", () => {
    const res = selectPaperAskChunks({
      allChunks: sampleChunks,
      maxChars: 150,
      hasEmbeddings: false,
    });
    assert.equal(res.mode, "head_truncated");
    assert.equal(res.chunks.length, 1);
    assert.equal(res.chunks[0]!.id, "c1");
    assert.ok(res.notice);
    assert.match(res.notice, /上限（約\d+万文字）を超えるため、先頭から/);
  });
});

describe("buildPaperAskPrompt: プロンプトの組み立て", () => {
  const chunks: PaperAskChunk[] = [
    { id: "chunk-a", chunk_index: 0, content: "Transformerの注意機構について説明します。", pdf_page: 2 },
  ];

  it("本文チャンク・質問・制約（書かれていない場合は「論文には書かれていません」）を含むプロンプトを組み立てる", () => {
    const prompt = buildPaperAskPrompt({
      chunks,
      question: "アテンションの計算式は何ですか？",
      history: [
        { role: "user", content: "この論文は何についてですか？" },
        { role: "assistant", content: "自然言語処理のモデルについてです。" },
      ],
    });

    assert.ok(prompt.system.includes("「論文には書かれていません」"));
    assert.ok(prompt.system.includes("JSON"));
    assert.ok(prompt.user.includes("chunk-a"));
    assert.ok(prompt.user.includes("p.2"));
    assert.ok(prompt.user.includes("Transformerの注意機構"));
    assert.ok(prompt.user.includes("【直前のやりとり】"));
    assert.ok(prompt.user.includes("アテンションの計算式は何ですか？"));
  });
});

describe("parsePaperAskResponse", () => {
  it("JSON 文字列から answer と referencedChunkIds を正しく抽出する", () => {
    const raw = JSON.stringify({
      answer: "自己注意機構が用いられています。",
      referencedChunkIds: ["c1", "c2"],
    });
    const parsed = parsePaperAskResponse(raw);
    assert.equal(parsed.answer, "自己注意機構が用いられています。");
    assert.deepEqual(parsed.referencedChunkIds, ["c1", "c2"]);
  });

  it("Markdown コードフェンスで囲まれた JSON もパースできる", () => {
    const raw = "```json\n" + JSON.stringify({
      answer: "論文には書かれていません。",
      referencedChunkIds: [],
    }) + "\n```";
    const parsed = parsePaperAskResponse(raw);
    assert.equal(parsed.answer, "論文には書かれていません。");
    assert.deepEqual(parsed.referencedChunkIds, []);
  });

  it("不正な JSON の場合は生テキストを answer として返し空配列をセットする", () => {
    const raw = "これはプレーンテキストの回答です。";
    const parsed = parsePaperAskResponse(raw);
    assert.equal(parsed.answer, "これはプレーンテキストの回答です。");
    assert.deepEqual(parsed.referencedChunkIds, []);
  });
});

describe("askPaperQuestion: LLM 偽物による単体テスト", () => {
  const sampleChunks: PaperAskChunk[] = [
    { id: "c1", chunk_index: 0, content: "深層学習における正規化手法を論じる。", pdf_page: 1 },
    { id: "c2", chunk_index: 1, content: "バッチ正規化の効果を実験により示す。", pdf_page: 3 },
  ];

  it("偽物 LLM の回答と根拠チャンクが正しく関連づけられて返る", async () => {
    const fakeLlm = async (p: { system: string; user: string }) => {
      assert.ok(p.user.includes("バッチ正規化"));
      return JSON.stringify({
        answer: "バッチ正規化の効果が示されています。",
        referencedChunkIds: ["c2"],
      });
    };

    const result = await askPaperQuestion({
      allChunks: sampleChunks,
      question: "どのような効果が示されていますか？",
      llmCaller: fakeLlm,
    });

    assert.equal(result.answer, "バッチ正規化の効果が示されています。");
    assert.equal(result.referencedChunks.length, 1);
    assert.equal(result.referencedChunks[0]!.id, "c2");
    assert.equal(result.referencedChunks[0]!.pdf_page, 3);
  });

  it("「書かれていない」回答のときは根拠チャンクが空配列になる", async () => {
    const fakeLlm = async () => {
      return JSON.stringify({
        answer: "論文には書かれていません。",
        referencedChunkIds: [],
      });
    };

    const result = await askPaperQuestion({
      allChunks: sampleChunks,
      question: "強化学習の報酬関数は何ですか？",
      llmCaller: fakeLlm,
    });

    assert.equal(result.answer, "論文には書かれていません。");
    assert.deepEqual(result.referencedChunks, []);
  });
});

describe("checkUserAskRateLimit: レート制限", () => {
  it("指定回数までは許可され、回数超過で 429 相当のブロック判定になる", () => {
    resetUserAskRateLimitForTests();
    const userId = "test-user-uuid-123";

    for (let i = 0; i < ASK_RATE_LIMIT_MAX_REQUESTS; i++) {
      const res = checkUserAskRateLimit(userId);
      assert.equal(res.allowed, true);
    }

    const blocked = checkUserAskRateLimit(userId);
    assert.equal(blocked.allowed, false);
    assert.ok(typeof blocked.retryAfterSeconds === "number" && blocked.retryAfterSeconds > 0);
  });
});
