import { jsonrepair } from "jsonrepair";

export type PaperAskChunk = {
  id: string;
  chunk_index: number;
  content: string;
  pdf_page: number | null;
  similarity?: number;
};

export type PaperAskChunkSelectionMode = "all" | "embedding" | "head_truncated";

export type SelectPaperAskChunksResult = {
  chunks: PaperAskChunk[];
  mode: PaperAskChunkSelectionMode;
  totalChars: number;
  maxChars: number;
  notice?: string;
};

export function selectPaperAskChunks(params: {
  allChunks: PaperAskChunk[];
  maxChars?: number;
  matchedChunks?: PaperAskChunk[] | null;
  hasEmbeddings?: boolean;
}): SelectPaperAskChunksResult {
  const maxChars =
    params.maxChars ??
    (Number(process.env.PAPER_ASK_MAX_CHARS) || 200_000);

  const allSorted = [...params.allChunks].sort(
    (a, b) => a.chunk_index - b.chunk_index,
  );
  const totalChars = allSorted.reduce((sum, c) => sum + c.content.length, 0);

  // 1. 全文が上限に収まる場合
  if (totalChars <= maxChars) {
    return {
      chunks: allSorted,
      mode: "all",
      totalChars,
      maxChars,
    };
  }

  // 2. 収まらず、埋め込みがある場合
  if (
    params.hasEmbeddings &&
    params.matchedChunks &&
    params.matchedChunks.length > 0
  ) {
    const picked: PaperAskChunk[] = [];
    let curChars = 0;
    for (const chunk of params.matchedChunks) {
      if (picked.length > 0 && curChars + chunk.content.length > maxChars) {
        break;
      }
      picked.push(chunk);
      curChars += chunk.content.length;
    }
    // 論文の読み順（chunk_index 順）に並び替える
    picked.sort((a, b) => a.chunk_index - b.chunk_index);
    return {
      chunks: picked,
      mode: "embedding",
      totalChars,
      maxChars,
    };
  }

  // 3. 収まらず、埋め込みがない（または検索失敗）場合: 先頭から上限まで渡す
  const picked: PaperAskChunk[] = [];
  let curChars = 0;
  for (const chunk of allSorted) {
    if (picked.length > 0 && curChars + chunk.content.length > maxChars) {
      break;
    }
    picked.push(chunk);
    curChars += chunk.content.length;
  }

  const limitWan = Math.round(maxChars / 10000);
  return {
    chunks: picked,
    mode: "head_truncated",
    totalChars,
    maxChars,
    notice: `本文の合計が上限（約${limitWan}万文字）を超えるため、先頭から上限までの範囲を対象に回答しています。`,
  };
}

export type PaperAskMessage = {
  role: "user" | "assistant";
  content: string;
};

export type BuildPaperAskPromptResult = {
  system: string;
  user: string;
};

export function buildPaperAskPrompt(params: {
  chunks: PaperAskChunk[];
  question: string;
  history?: PaperAskMessage[];
}): BuildPaperAskPromptResult {
  const history = (params.history ?? []).slice(-6);

  const system = [
    "あなたは学術論文の内容について質問に答える専門アシスタントです。",
    "以下の規則を厳格に遵守してください：",
    "1. 回答の根拠は、提供された【論文の本文チャンク】の記述のみに限られます。外部の知識や推測を絶対に混ぜないでください。",
    "2. 質問された内容が論文の本文チャンクに書かれていない場合は、必ず「論文には書かれていません」と答えてください。",
    "3. 出力は必ず以下の JSON 形式で返してください。コードブロック表記（```json など）は含めないでください。",
    "",
    "出力 JSON フォーマット:",
    "{",
    '  "answer": "質問に対する親切で明瞭な日本語の回答（本文にない場合は「論文には書かれていません」）",',
    '  "referencedChunkIds": ["回答の根拠・論拠としたチャンクの ID 配列（本文にない場合は空配列 []）"]',
    "}",
  ].join("\n");

  const chunkBlocks = params.chunks
    .map((c) => {
      const pageLabel = c.pdf_page != null ? `p.${c.pdf_page}` : "ページ不明";
      return `[チャンク ID: ${c.id} | ページ: ${pageLabel} | インデックス: ${c.chunk_index}]\n${c.content.trim()}`;
    })
    .join("\n\n---\n\n");

  const historyBlocks =
    history.length > 0
      ? [
          "【直前のやりとり】",
          ...history.map((m) =>
            m.role === "user"
              ? `ユーザー: ${m.content}`
              : `アシスタント: ${m.content}`,
          ),
          "",
        ].join("\n")
      : "";

  const user = [
    "【論文の本文チャンク】",
    chunkBlocks,
    "",
    historyBlocks,
    "【質問】",
    params.question.trim(),
    "",
    "上記【論文の本文チャンク】のみを材料として回答し、指示された JSON 形式で出力してください。",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}

export type PaperAskResponseParsed = {
  answer: string;
  referencedChunkIds: string[];
};

export function parsePaperAskResponse(raw: string): PaperAskResponseParsed {
  const trimmed = raw.trim();
  const unquoted = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  // 1. 通常の JSON パース
  try {
    const parsed = JSON.parse(unquoted);
    if (parsed && typeof parsed === "object" && typeof parsed.answer === "string") {
      const ids = Array.isArray(parsed.referencedChunkIds)
        ? parsed.referencedChunkIds.filter((x: unknown): x is string => typeof x === "string")
        : [];
      return { answer: parsed.answer.trim(), referencedChunkIds: ids };
    }
  } catch {
    // 2. jsonrepair でのフォールバック
    try {
      const repaired = jsonrepair(unquoted);
      const parsed = JSON.parse(repaired);
      if (parsed && typeof parsed === "object" && typeof parsed.answer === "string") {
        const ids = Array.isArray(parsed.referencedChunkIds)
          ? parsed.referencedChunkIds.filter((x: unknown): x is string => typeof x === "string")
          : [];
        return { answer: parsed.answer.trim(), referencedChunkIds: ids };
      }
    } catch {
      // 3. パース不能時は生テキストを回答にする
    }
  }

  return {
    answer: trimmed,
    referencedChunkIds: [],
  };
}

export type PaperAskResult = {
  answer: string;
  referencedChunks: Array<{
    id: string;
    chunk_index: number;
    content: string;
    pdf_page: number | null;
  }>;
  notice?: string;
};

export async function askPaperQuestion(params: {
  allChunks: PaperAskChunk[];
  question: string;
  history?: PaperAskMessage[];
  matchedChunks?: PaperAskChunk[] | null;
  hasEmbeddings?: boolean;
  maxChars?: number;
  llmCaller?: (prompt: BuildPaperAskPromptResult) => Promise<string>;
}): Promise<PaperAskResult> {
  const selection = selectPaperAskChunks({
    allChunks: params.allChunks,
    maxChars: params.maxChars,
    matchedChunks: params.matchedChunks,
    hasEmbeddings: params.hasEmbeddings,
  });

  const prompt = buildPaperAskPrompt({
    chunks: selection.chunks,
    question: params.question,
    history: params.history,
  });

  const caller =
    params.llmCaller ??
    (async (p) => {
      const { callGeminiText } = await import("./claude-quiz.ts");
      return callGeminiText(p);
    });
  const rawText = await caller(prompt);
  const parsed = parsePaperAskResponse(rawText);

  const chunkMap = new Map<string, PaperAskChunk>();
  for (const c of selection.chunks) {
    chunkMap.set(c.id, c);
  }

  let referencedChunks = parsed.referencedChunkIds
    .map((id) => chunkMap.get(id))
    .filter((c): c is PaperAskChunk => c != null)
    .map((c) => ({
      id: c.id,
      chunk_index: c.chunk_index,
      content: c.content,
      pdf_page: c.pdf_page,
    }));

  // 単一チャンクのみで書かれていないと答えていない場合、IDが落ちていても根拠として補完
  if (
    referencedChunks.length === 0 &&
    selection.chunks.length === 1 &&
    !parsed.answer.includes("書かれていません") &&
    !parsed.answer.includes("書かれていない")
  ) {
    const single = selection.chunks[0]!;
    referencedChunks = [
      {
        id: single.id,
        chunk_index: single.chunk_index,
        content: single.content,
        pdf_page: single.pdf_page,
      },
    ];
  }

  return {
    answer: parsed.answer,
    referencedChunks,
    notice: selection.notice,
  };
}
