import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const anthropicModel =
  process.env.ANTHROPIC_MODEL?.trim() || "claude-3-5-sonnet-20241022";

const geminiRetryMax = Math.min(
  6,
  Math.max(1, Number.parseInt(process.env.GEMINI_RETRY_MAX || "4", 10) || 4),
);

function geminiModelCandidates(): string[] {
  const raw = process.env.GEMINI_MODEL?.trim();
  if (!raw) return ["gemini-2.5-flash"];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : ["gemini-2.5-flash"];
}

type Provider = "anthropic" | "gemini";

function anthropicConfigured(): boolean {
  const k = process.env.ANTHROPIC_API_KEY?.trim();
  return Boolean(k && k.startsWith("sk-ant"));
}

function geminiKey(): string | undefined {
  const k =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim();
  if (!k) return undefined;
  if (k.startsWith("your_")) return undefined;
  return k;
}

function geminiConfigured(): boolean {
  return Boolean(geminiKey());
}

function resolveProvider(): Provider {
  const raw = process.env.LLM_PROVIDER?.replace(/^\uFEFF/, "").trim().toLowerCase();
  if (raw === "gemini") {
    if (!geminiConfigured()) throw new Error("GEMINI_API_KEY が未設定です");
    return "gemini";
  }
  if (raw === "anthropic") {
    if (!anthropicConfigured()) throw new Error("ANTHROPIC_API_KEY が未設定です");
    return "anthropic";
  }
  if (anthropicConfigured()) return "anthropic";
  if (geminiConfigured()) return "gemini";
  throw new Error("LLM の API キーが未設定です");
}

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

export async function generateLlmText(params: {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const provider = resolveProvider();
  const maxTokens = params.maxTokens ?? 1400;
  const temperature = params.temperature ?? 0.2;

  if (provider === "anthropic") {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!.trim(),
    });
    const res = await client.messages.create({
      model: anthropicModel,
      max_tokens: maxTokens,
      temperature,
      ...(params.system
        ? { system: params.system, messages: [{ role: "user", content: params.user }] }
        : { messages: [{ role: "user", content: params.user }] }),
    });
    return res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  }

  const genAI = new GoogleGenerativeAI(geminiKey()!);
  let lastMsg = "";
  for (const modelName of geminiModelCandidates()) {
    const model = genAI.getGenerativeModel({
      model: modelName,
      ...(params.system ? { systemInstruction: params.system } : {}),
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
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
  throw new Error(lastMsg || "Gemini 呼び出しに失敗しました");
}

