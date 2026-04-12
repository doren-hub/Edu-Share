import OpenAI from "openai";

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");

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
