import { generateLlmText } from "./llm-text.ts";
import { untrustedDocumentInstruction, wrapUntrustedDocument } from "./untrusted-document.ts";

function sanitizePdfText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function summarizeByLlm(
  raw: string,
  generate: typeof generateLlmText = generateLlmText,
): Promise<string> {
  const context = sanitizePdfText(raw).slice(0, 14000);
  if (!context) return "";
  const text = await generate({
    system:
      "あなたは論文・技術文書の要約アシスタントです。日本語で簡潔かつ正確に要約します。" + untrustedDocumentInstruction,
    user: `以下の資料本文（抽出テキスト）を読み、次の見出しで要約してください。
- 主な研究手法
- 主要な発見
- 推奨事項
- 結論

注意:
- 数値・固有名詞は本文にある場合のみ書く
- 不明な情報は推測しない
- 出力は日本語

本文:
${wrapUntrustedDocument(context)}`,
    maxTokens: 1200,
    temperature: 0.2,
  });
  return text.trim();
}

