import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { jsonrepair } from "jsonrepair";
import type { AnswerMap, ClientQuestion, StoredQuestion } from "@/lib/types";
import { csvMcHintTextForStripClient } from "@/lib/notebooklm-csv";
import type { QuizContextChunk } from "@/lib/quiz-chunk-coverage";
import { excerptAppearsInJoined } from "@/lib/source-excerpt";

const anthropicModel =
  process.env.ANTHROPIC_MODEL?.trim() || "claude-3-5-sonnet-20241022";
/** カンマ区切りで複数指定可（先頭から試し、503 等はリトライ後に次へ）。未設定時は 2.5 のみ。 */
function geminiModelCandidates(): string[] {
  const raw = process.env.GEMINI_MODEL?.trim();
  if (!raw) return ["gemini-2.5-flash"];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : ["gemini-2.5-flash"];
}

const geminiRetryMax = Math.min(
  6,
  Math.max(1, Number.parseInt(process.env.GEMINI_RETRY_MAX || "4", 10) || 4),
);

function isTransientGeminiError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /\b503\b/.test(msg) ||
    /\b429\b/.test(msg) ||
    /\b500\b/.test(msg) ||
    /Service Unavailable/i.test(msg) ||
    /RESOURCE_EXHAUSTED/i.test(msg) ||
    /try again later/i.test(msg) ||
    /UNAVAILABLE/i.test(msg) ||
    /overloaded/i.test(msg) ||
    /Too Many Requests/i.test(msg)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LlmProvider = "anthropic" | "gemini";

function anthropicConfigured(): boolean {
  const k = process.env.ANTHROPIC_API_KEY?.trim();
  if (!k) return false;
  if (k === "your_anthropic_key") return false;
  if (k.startsWith("your_")) return false;
  // Claude の秘密鍵は sk-ant- で始まる。Google（Gemini）用の AIza... を誤って入れた場合は無効扱い
  if (!k.startsWith("sk-ant")) return false;
  return true;
}

function geminiKey(): string | undefined {
  const k =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim();
  if (!k) return undefined;
  if (k === "your_gemini_key" || k === "your_google_key") return undefined;
  if (k.startsWith("your_")) return undefined;
  return k;
}

function geminiConfigured(): boolean {
  return Boolean(geminiKey());
}

function resolveProvider(): LlmProvider {
  const raw = process.env.LLM_PROVIDER?.replace(/^\uFEFF/, "").trim().toLowerCase();
  if (raw === "gemini") {
    if (!geminiConfigured()) {
      throw new Error(
        "LLM_PROVIDER=gemini ですが GEMINI_API_KEY（または GOOGLE_API_KEY）が未設定かサンプルのままです。Google AI Studio でキーを発行し .env.local に設定し、開発サーバーを再起動してください。",
      );
    }
    return "gemini";
  }
  if (raw === "anthropic") {
    if (!anthropicConfigured()) {
      throw new Error(
        "LLM_PROVIDER=anthropic ですが ANTHROPIC_API_KEY が未設定かサンプルのままです。.env.local を確認し、開発サーバーを再起動してください。",
      );
    }
    return "anthropic";
  }
  if (anthropicConfigured()) return "anthropic";
  if (geminiConfigured()) return "gemini";
  const anth = process.env.ANTHROPIC_API_KEY?.trim();
  const hint =
    anth?.startsWith("AIza") &&
    !process.env.GEMINI_API_KEY?.trim() &&
    !process.env.GOOGLE_API_KEY?.trim()
      ? " ANTHROPIC_API_KEY に Google（Gemini）用のキーが入っている可能性があります。GEMINI_API_KEY に移し、不要なら ANTHROPIC_API_KEY の行は削除またはコメントアウトしてください。"
      : anth?.startsWith("AIza")
        ? " ANTHROPIC_API_KEY に Google 用キーが残っています。Gemini では GEMINI_API_KEY のみを使います（Anthropic は sk-ant- で始まるキー）。"
        : "";
  throw new Error(
    "LLM の API キーがありません。.env.local に ANTHROPIC_API_KEY（sk-ant- で始まる Claude 用）または GEMINI_API_KEY（Google AI Studio）を設定し、保存したうえで開発サーバーを再起動してください。" +
      hint,
  );
}

async function generateText(params: {
  system?: string;
  user: string;
  maxTokens: number;
  temperature: number;
}): Promise<string> {
  const provider = resolveProvider();
  if (provider === "anthropic") {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!.trim(),
    });
    let res;
    try {
      res = await client.messages.create({
        model: anthropicModel,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        ...(params.system
          ? { system: params.system, messages: [{ role: "user", content: params.user }] }
          : { messages: [{ role: "user", content: params.user }] }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Claude API の呼び出しに失敗しました（モデル名・APIキー・利用枠を確認）。model=${anthropicModel} / ${msg}`,
      );
    }
    return res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  }

  const genAI = new GoogleGenerativeAI(geminiKey()!);
  const models = geminiModelCandidates();
  let lastMsg = "";

  for (const modelName of models) {
    const model = genAI.getGenerativeModel({
      model: modelName,
      ...(params.system ? { systemInstruction: params.system } : {}),
      generationConfig: {
        maxOutputTokens: params.maxTokens,
        temperature: params.temperature,
      },
    });

    for (let attempt = 0; attempt < geminiRetryMax; attempt++) {
      try {
        const result = await model.generateContent(params.user);
        return result.response.text().trim();
      } catch (e) {
        lastMsg = e instanceof Error ? e.message : String(e);
        const retry = isTransientGeminiError(e) && attempt < geminiRetryMax - 1;
        if (retry) {
          await sleep(700 * 2 ** attempt);
          continue;
        }
        break;
      }
    }
  }

  throw new Error(
    `Gemini API の呼び出しに失敗しました（モデル名・APIキー・利用枠・混雑時の再試行を確認）。models=[${models.join(", ")}] retries=${geminiRetryMax} / ${lastMsg}`,
  );
}

/**
 * 先頭の `[` から、文字列リテラルを考慮して対応する `]` までを切り出す。
 * `lastIndexOf("]")` だと配列内の `]` やトークン切れで誤スライスになることがある。
 */
function sliceBalancedJsonArray(source: string): string | null {
  const start = source.indexOf("[");
  if (start === -1) return null;
  const stack: ("[" | "{")[] = [];
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "[") {
      stack.push("[");
      continue;
    }
    if (c === "{") {
      stack.push("{");
      continue;
    }
    if (c === "]") {
      const p = stack.pop();
      if (p !== "[") return null;
      if (stack.length === 0) return source.slice(start, i + 1);
      continue;
    }
    if (c === "}") {
      const p = stack.pop();
      if (p !== "{") return null;
      continue;
    }
  }
  return null;
}

function stripJsonNoise(s: string): string {
  return s.replace(/\u0000/g, "");
}

/**
 * LLM が返す「ほぼ JSON」の配列をパースする。
 * フェンス除去・バランス切り出し・jsonrepair・切れ尾の接尾辞修復を段階的に試す。
 */
function extractJsonArray(text: string): unknown {
  let t = text.trim().replace(/^\uFEFF/, "");
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1]!.trim();

  const start = t.indexOf("[");
  if (start === -1) {
    throw new Error("LLM の応答に JSON 配列が含まれていません");
  }

  const balanced = sliceBalancedJsonArray(t);
  const end = t.lastIndexOf("]");
  const legacySlice =
    end > start ? stripJsonNoise(t.slice(start, end + 1)) : "";
  const fromBracket = stripJsonNoise(t.slice(start));

  const candidates: string[] = [];
  const push = (s: string | null | undefined) => {
    const u = typeof s === "string" ? s.trim() : "";
    if (u.length > 0 && !candidates.includes(u)) candidates.push(u);
  };
  push(balanced != null ? stripJsonNoise(balanced) : null);
  push(legacySlice);
  push(fromBracket);
  push(stripJsonNoise(t));

  const suffixes = ["", "]", "}]", '"}]', '"]}', '"}]}', '"]}]}', '"}}]'];

  let lastPrimary = "";
  let lastRepair = "";
  for (const raw0 of candidates) {
    const baseVariants: string[] = [raw0];
    try {
      const jr = jsonrepair(raw0);
      if (jr !== raw0) baseVariants.push(jr);
    } catch {
      /* jsonrepair 単体が落ちる長大・壊れ入力はスキップ */
    }
    for (const raw of baseVariants) {
      for (const suf of suffixes) {
        const candidate = raw + suf;
        try {
          const parsed = JSON.parse(candidate) as unknown;
          if (Array.isArray(parsed)) return parsed;
        } catch (e) {
          if (!lastPrimary) lastPrimary = e instanceof Error ? e.message : String(e);
        }
        try {
          const repaired = jsonrepair(candidate);
          const parsed = JSON.parse(repaired) as unknown;
          if (Array.isArray(parsed)) return parsed;
        } catch (e) {
          if (!lastRepair) lastRepair = e instanceof Error ? e.message : String(e);
        }
      }
    }
  }

  const preview = stripJsonNoise(t).slice(0, 200).replace(/\s+/g, " ");
  const hint = lastRepair || lastPrimary || "unknown";
  throw new Error(
    `LLM の JSON の解析に失敗しました（${hint}）。応答の先頭 200 文字: ${preview}`,
  );
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

function resolvePdfPageForExcerpt(
  excerpt: string | undefined,
  chunks: QuizContextChunk[],
): number | null {
  const ex = excerpt?.replace(/\s+/g, " ").trim().toLowerCase();
  if (!ex || ex.length < 8) return null;
  const needle = ex.slice(0, Math.min(100, ex.length));
  const shortNeedle = needle.slice(0, Math.min(60, needle.length));
  for (const c of chunks) {
    if (c.pdfPage == null) continue;
    const hay = c.content.replace(/\s+/g, " ").trim().toLowerCase();
    if (hay.includes(shortNeedle)) return c.pdfPage;
  }
  return null;
}

function attachSourcePdfPages(questions: StoredQuestion[], chunks: QuizContextChunk[]): void {
  for (const q of questions) {
    const p = resolvePdfPageForExcerpt(q.sourceExcerpt, chunks);
    if (p == null) continue;
    q.sourcePdfPage = p;
  }
}

export async function generateQuizFromContext(params: {
  contextChunks: QuizContextChunk[];
  documentType: "past_exam" | "paper";
  nonce: string;
}): Promise<StoredQuestion[]> {
  const joined = params.contextChunks
    .map((c, i) => {
      const tag =
        c.pdfPage != null ? `--- 抜粋 ${i + 1} (PDF p.${c.pdfPage}) ---` : `--- 抜粋 ${i + 1} ---`;
      return `${tag}\n${c.content}`;
    })
    .join("\n\n");
  const joinedForValidate = joined.replace(/---\s*抜粋\s*\d+\s*---\s*/g, "\n");

  const system = `あなたは教材設計の専門家です。与えられた抜粋のみを根拠に、日本語のテスト問題を生成します。
厳守:
- 参考文献・文献一覧・References / Bibliography に相当する段落からは設問を作らない。本文のみを根拠にする（該当箇所が抜粋に含まれていても無視する）。
- 抜粋に無い事実を捏造しない（不足なら「抜粋の範囲では判断できない」系の設問にする）
- 選択式は4択、正解は1つ。correctIndexは0始まり。
- 記述式は短答〜中程度（200字以内想定）で採点可能な明確な問い。
- 設問タイプをランダムにミックス（毎回バラつかせる）。合計6〜9問。
- 各設問に必須フィールド sourceExcerpt を付ける。値は「抜粋」ブロック（--- 抜粋 N --- 以降の本文）から、設問の根拠となった部分を**改変せずに連続コピー**した文字列（最低16文字。可能なら80文字以上推奨）。空白の増減のみ可。
- 出力はJSON配列のみ（前後に説明文を付けない）。各要素は次のいずれかの形:
  {"id":"q1","type":"multiple_choice","sourceExcerpt":"（抜粋からの原文コピー）","prompt":"...","options":["A","B","C","D"],"correctIndex":0}
  {"id":"e1","type":"essay","sourceExcerpt":"（抜粋からの原文コピー）","prompt":"...","referenceAnswer":"採点用の模範解答（短く）"}`;

  const user = `document_type: ${params.documentType}
session_entropy: ${params.nonce}

抜粋:
${joined}`;

  const text = await generateText({
    system,
    user,
    maxTokens: 8192,
    temperature: 0.9,
  });

  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) throw new Error("Expected JSON array");

  const out: StoredQuestion[] = [];
  for (const item of parsed) {
    if (isMcq(item)) {
      const opts = item.options.map((s) => s.trim()).filter(Boolean);
      if (opts.length < 2) continue;
      const rawEx = (item as { sourceExcerpt?: unknown }).sourceExcerpt;
      const sourceExcerpt =
        typeof rawEx === "string" ? rawEx.replace(/\s+/g, " ").trim() : "";
      if (!excerptAppearsInJoined(sourceExcerpt, joinedForValidate)) continue;
      const idx = Math.min(Math.max(0, item.correctIndex), opts.length - 1);
      out.push({
        id: item.id,
        type: "multiple_choice",
        prompt: item.prompt,
        options: opts,
        correctIndex: idx,
        sourceExcerpt,
      });
    } else if (isEssay(item)) {
      const rawEx = (item as { sourceExcerpt?: unknown }).sourceExcerpt;
      const sourceExcerpt =
        typeof rawEx === "string" ? rawEx.replace(/\s+/g, " ").trim() : "";
      if (!excerptAppearsInJoined(sourceExcerpt, joinedForValidate)) continue;
      out.push({
        id: item.id,
        type: "essay",
        prompt: item.prompt,
        referenceAnswer:
          typeof item.referenceAnswer === "string"
            ? item.referenceAnswer
            : undefined,
        sourceExcerpt,
      });
    }
  }

  // 3 問未満でも返す。不足分は API 側で同一教材の過去セッションからランダム補填する。
  attachSourcePdfPages(out, params.contextChunks);
  return out;
}

export function stripForClient(questions: StoredQuestion[]): ClientQuestion[] {
  return questions.map((q) => {
    if (q.type === "multiple_choice") {
      const hintText = csvMcHintTextForStripClient(q);
      const {
        correctIndex: _c,
        sourceExcerpt: _s,
        sourcePdfPage: _p,
        sourceOriginalText: _o,
        sourcePdfHighlightRects: _hr,
        sourcePdfHighlightMeta: _hm,
        notebookLmCsvRationale: _nr,
        notebookLmCsvHint: _nh,
        ...rest
      } = q;
      return {
        ...rest,
        ...(hintText ? { notebookLmCsvHint: hintText } : {}),
      };
    }
    const {
      referenceAnswer: _r,
      sourceExcerpt: _s,
      sourcePdfPage: _p,
      sourceOriginalText: _o,
      sourcePdfHighlightRects: _hr,
      sourcePdfHighlightMeta: _hm,
      ...rest
    } = q;
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

  const provider = resolveProvider();
  const apiLabel = provider === "anthropic" ? "Claude API" : "Gemini API";

  for (const q of essays) {
    essayMax += 10;
    const ans = params.answers[q.id];
    const answerText = typeof ans === "string" ? ans : "";

    const prompt = `次の記述式問題を採点してください。0〜10の整数点。簡潔な講評（日本語1〜3文）。
出力はJSONのみ: {"score":0,"comment":"..."}

問題: ${q.prompt}
模範解答（参考）: ${q.referenceAnswer ?? "（なし）"}
受験者の回答: ${answerText || "（未回答）"}`;

    let text: string;
    try {
      text = await generateText({
        user: prompt,
        maxTokens: 400,
        temperature: 0.2,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      perEssay.push({
        id: q.id,
        score: 0,
        max: 10,
        comment: `${apiLabel} エラー: ${msg}`,
      });
      continue;
    }

    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const rawObj = text.slice(start, end + 1);
      let json: { score?: number; comment?: string };
      try {
        json = JSON.parse(rawObj) as { score?: number; comment?: string };
      } catch {
        json = JSON.parse(jsonrepair(rawObj)) as { score?: number; comment?: string };
      }
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
