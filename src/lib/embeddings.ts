import OpenAI from "openai";

/** 埋め込み API を呼び出してよいか（未設定・サンプル文字列は false） */
export function openAiEmbeddingsEnabled(): boolean {
  const k = process.env.OPENAI_API_KEY?.trim();
  if (!k) return false;
  if (k === "your_openai_key_for_embeddings") return false;
  if (k.startsWith("your_")) return false;
  return true;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!openAiEmbeddingsEnabled()) {
    throw new Error(
      "OPENAI_API_KEY が未設定かサンプルのままです。有効なキーを .env.local に設定するか、行を削除してください。",
    );
  }
  const key = process.env.OPENAI_API_KEY!.trim();

  const openai = new OpenAI({ apiKey: key });
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
    dimensions: 1536,
  });

  return res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding as number[]);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v;
}
