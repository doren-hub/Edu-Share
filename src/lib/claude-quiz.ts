import Anthropic from "@anthropic-ai/sdk";
import type { AnswerMap, ClientQuestion, StoredQuestion } from "@/lib/types";

const model =
  process.env.ANTHROPIC_MODEL?.trim() || "claude-3-5-sonnet-20241022";

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey: key });
}

function extractJsonArray(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Claude response did not contain a JSON array");
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

function isMcq(x: unknown): x is {
  id: string;
  type: "multiple_choice";
  prompt: string;
  options: string[];
  correctIndex: number;
} {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o.type === "multiple_choice" &&
    typeof o.id === "string" &&
    typeof o.prompt === "string" &&
    Array.isArray(o.options) &&
    o.options.every((t) => typeof t === "string") &&
    typeof o.correctIndex === "number"
  );
}

function isEssay(x: unknown): x is {
  id: string;
  type: "essay";
  prompt: string;
  referenceAnswer?: string;
} {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o.type === "essay" &&
    typeof o.id === "string" &&
    typeof o.prompt === "string"
  );
}

export async function generateQuizFromContext(params: {
  contextChunks: string[];
  documentType: "past_exam" | "paper";
  nonce: string;
}): Promise<StoredQuestion[]> {
  const client = getClient();
  const joined = params.contextChunks
    .map((c, i) => `--- 抜粋 ${i + 1} ---\n${c}`)
    .join("\n\n");

  const system = `あなたは教材設計の専門家です。与えられた抜粋のみを根拠に、日本語のテスト問題を生成します。
厳守:
- 抜粋に無い事実を捏造しない（不足なら「抜粋の範囲では判断できない」系の設問にする）
- 選択式は4択、正解は1つ。correctIndexは0始まり。
- 記述式は短答〜中程度（200字以内想定）で採点可能な明確な問い。
- 設問タイプをランダムにミックス（毎回バラつかせる）。合計6〜9問。
- 出力はJSON配列のみ（前後に説明文を付けない）。各要素は次のいずれかの形:
  {"id":"q1","type":"multiple_choice","prompt":"...","options":["A","B","C","D"],"correctIndex":0}
  {"id":"e1","type":"essay","prompt":"...","referenceAnswer":"採点用の模範解答（短く）"}`;

  const user = `document_type: ${params.documentType}
session_entropy: ${params.nonce}

抜粋:
${joined}`;

  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    temperature: 0.9,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();

  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) throw new Error("Expected JSON array");

  const out: StoredQuestion[] = [];
  for (const item of parsed) {
    if (isMcq(item)) {
      const opts = item.options.map((s) => s.trim()).filter(Boolean);
      if (opts.length < 2) continue;
      const idx = Math.min(Math.max(0, item.correctIndex), opts.length - 1);
      out.push({
        id: item.id,
        type: "multiple_choice",
        prompt: item.prompt,
        options: opts,
        correctIndex: idx,
      });
    } else if (isEssay(item)) {
      out.push({
        id: item.id,
        type: "essay",
        prompt: item.prompt,
        referenceAnswer:
          typeof item.referenceAnswer === "string"
            ? item.referenceAnswer
            : undefined,
      });
    }
  }

  if (out.length < 3) {
    throw new Error("生成された問題数が不足しています。もう一度お試しください。");
  }
  return out;
}

export function stripForClient(questions: StoredQuestion[]): ClientQuestion[] {
  return questions.map((q) => {
    if (q.type === "multiple_choice") {
      const { correctIndex: _c, ...rest } = q;
      return rest;
    }
    const { referenceAnswer: _r, ...rest } = q;
    return rest;
  });
}

export async function gradeWithClaude(params: {
  questions: StoredQuestion[];
  answers: AnswerMap;
}): Promise<{
  scoreMc: number;
  scoreEssay: number;
  scoreTotal: number;
  feedback: unknown;
}> {
  const client = getClient();
  let mcCorrect = 0;
  let mcTotal = 0;
  for (const q of params.questions) {
    if (q.type !== "multiple_choice") continue;
    mcTotal += 1;
    const a = params.answers[q.id];
    if (typeof a === "number" && a === q.correctIndex) mcCorrect += 1;
  }

  const essays = params.questions.filter((q) => q.type === "essay");
  let essayPoints = 0;
  let essayMax = 0;
  const perEssay: Array<{
    id: string;
    score: number;
    max: number;
    comment: string;
  }> = [];

  for (const q of essays) {
    essayMax += 10;
    const ans = params.answers[q.id];
    const answerText = typeof ans === "string" ? ans : "";

    const prompt = `次の記述式問題を採点してください。0〜10の整数点。簡潔な講評（日本語1〜3文）。
出力はJSONのみ: {"score":0,"comment":"..."}

問題: ${q.prompt}
模範解答（参考）: ${q.referenceAnswer ?? "（なし）"}
受験者の回答: ${answerText || "（未回答）"}`;

    const res = await client.messages.create({
      model,
      max_tokens: 400,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });

    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const json = JSON.parse(text.slice(start, end + 1)) as {
        score?: number;
        comment?: string;
      };
      const s = Math.min(10, Math.max(0, Math.round(Number(json.score ?? 0))));
      essayPoints += s;
      perEssay.push({
        id: q.id,
        score: s,
        max: 10,
        comment: String(json.comment ?? ""),
      });
    } catch {
      perEssay.push({
        id: q.id,
        score: 0,
        max: 10,
        comment: "採点に失敗しました（形式エラー）",
      });
    }
  }

  const mcScore100 =
    mcTotal === 0 ? 0 : Math.round((mcCorrect / mcTotal) * 100);
  const essayScore100 =
    essayMax === 0 ? 0 : Math.round((essayPoints / essayMax) * 100);

  const parts: number[] = [];
  if (mcTotal > 0) parts.push(mcScore100);
  if (essayMax > 0) parts.push(essayScore100);
  const scoreTotal =
    parts.length === 0 ? 0 : Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);

  return {
    scoreMc: mcScore100,
    scoreEssay: essayScore100,
    scoreTotal,
    feedback: {
      multipleChoice: { correct: mcCorrect, total: mcTotal },
      essays: perEssay,
    },
  };
}
