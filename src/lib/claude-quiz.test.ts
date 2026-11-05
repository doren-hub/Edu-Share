import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicModel } from "./anthropic-config.ts";
import {
  generateQuizFromContext,
  gradeWithClaude,
  type QuizAnthropicClient,
} from "./claude-quiz.ts";
import type { StoredQuestion } from "./types.ts";

const excerpt = "光合成では光エネルギーを使って二酸化炭素と水から有機物を作ります。";
const quizParams = {
  contextChunks: [{ content: excerpt, pdfPage: 3 }],
  documentType: "paper" as const,
  nonce: "test-nonce",
};
const questions: StoredQuestion[] = [
  { id: "q1", type: "multiple_choice", prompt: "正解は？", options: ["A", "B"], correctIndex: 1 },
  { id: "e1", type: "essay", prompt: "光合成を説明", referenceAnswer: excerpt },
];

function fakeClient(replies: Array<string | Error>) {
  const calls: Parameters<QuizAnthropicClient["messages"]["create"]>[0][] = [];
  const client: QuizAnthropicClient = {
    messages: {
      async create(params) {
        calls.push(params);
        assert.ok(replies.length, "unexpected API call");
        const reply = replies.shift()!;
        if (reply instanceof Error) throw reply;
        // 複数の text ブロックを結合する実経路も通す。
        const split = Math.floor(reply.length / 2);
        return { content: [
          { type: "text", text: reply.slice(0, split), citations: null },
          { type: "text", text: reply.slice(split), citations: null },
        ] };
      },
    },
  };
  return { client, calls };
}

// 実キーや SDK の通信を使わない。プロバイダー設定も注入経路では不要。
test("出題: 偽クライアントの応答を検証し、原文と PDF ページを付ける", async () => {
  const valid = questions.map((q) => ({ ...q, sourceExcerpt: excerpt }));
  const f = fakeClient([JSON.stringify([
    ...valid,
    { ...valid[0], id: "invalid-source", sourceExcerpt: "これは教材の中に存在していない架空の説明文です。" },
    { ...valid[0], id: "invalid-options", options: ["A", " "] },
    { type: "unknown" },
  ])]);
  const result = await generateQuizFromContext(quizParams, f.client);
  assert.deepEqual(result, valid.map((q) => ({ ...q, sourcePdfPage: 3 })));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].model, anthropicModel());
  assert.equal(f.calls[0].max_tokens, 8192);
  assert.match(String(f.calls[0].system), /教材設計/);
  assert.match(String(f.calls[0].messages[0].content), /test-nonce/);
  assert.ok(String(f.calls[0].messages[0].content).includes(excerpt));
});

test("出題: 修復可能な JSON を受け入れる", async () => {
  const reply = JSON.stringify([{ ...questions[0], sourceExcerpt: excerpt }]);
  const f = fakeClient([`\`\`\`json\n${reply.slice(0, -1)},]\n\`\`\``]);
  assert.equal((await generateQuizFromContext(quizParams, f.client)).length, 1);
});

test("出題: JSON 配列がない応答はエラー", async () => {
  const f = fakeClient(["応答を生成できませんでした"]);
  await assert.rejects(generateQuizFromContext(quizParams, f.client), /JSON 配列が含まれていません/);
});

test("出題: API エラーにはモデル名と原因を付ける", async () => {
  const f = fakeClient([new Error("rate limited")]);
  await assert.rejects(generateQuizFromContext(quizParams, f.client), (e: Error) => {
    assert.ok(e.message.includes(`model=${anthropicModel()}`));
    assert.match(e.message, /Claude API.*rate limited/);
    return true;
  });
});

test("採点: 選択式をローカル採点し、記述式だけ API に渡す", async () => {
  const f = fakeClient(['{"score":7.6,"comment":"よく説明できています"}']);
  const result = await gradeWithClaude({ questions, answers: { q1: 1, e1: "光を使います" } }, f.client);
  assert.deepEqual(result, {
    scoreMc: 100, scoreEssay: 80, scoreTotal: 90,
    feedback: { multipleChoice: { correct: 1, total: 1 }, essays: [
      { id: "e1", score: 8, max: 10, comment: "よく説明できています" },
    ] },
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].model, anthropicModel());
  assert.equal(f.calls[0].max_tokens, 400);
  assert.equal(f.calls[0].system, undefined);
  assert.match(String(f.calls[0].messages[0].content), /光を使います/);
  assert.ok(String(f.calls[0].messages[0].content).includes(excerpt));
});

test("採点: 形式不正・API エラーは 0 点と講評にし、後続の採点を続ける", async () => {
  const f = fakeClient(["not JSON", new Error("service unavailable"), '{"score":15,"comment":"満点"}']);
  const essays = ["e1", "e2", "e3"].map((id) => ({ ...questions[1], id }));
  const result = await gradeWithClaude({ questions: essays, answers: {} }, f.client);
  assert.equal(result.scoreEssay, 33);
  assert.equal(result.scoreTotal, 33);
  assert.deepEqual(result.feedback, {
    multipleChoice: { correct: 0, total: 0 },
    essays: [
      { id: "e1", score: 0, max: 10, comment: "採点に失敗しました（形式エラー）" },
      { id: "e2", score: 0, max: 10, comment: `Claude API エラー: Claude API の呼び出しに失敗しました（モデル名・APIキー・利用枠を確認）。model=${anthropicModel()} / service unavailable` },
      { id: "e3", score: 10, max: 10, comment: "満点" },
    ],
  });
  assert.equal(f.calls.length, 3);
  assert.match(String(f.calls[0].messages[0].content), /（未回答）/);
});

test("採点: 選択式のみならクライアントを呼ばない", async () => {
  const f = fakeClient([]);
  const result = await gradeWithClaude({ questions: [questions[0]], answers: { q1: 0 } }, f.client);
  assert.equal(result.scoreMc, 0);
  assert.equal(result.scoreTotal, 0);
  assert.equal(f.calls.length, 0);
});
