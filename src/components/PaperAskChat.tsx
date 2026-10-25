"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";

export type ReferencedChunk = {
  id: string;
  chunk_index: number;
  content: string;
  pdf_page: number | null;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  referencedChunks?: ReferencedChunk[];
  notice?: string;
};

export function PaperAskChat({
  testId,
  isLoggedIn,
  onSelectChunkPage,
}: {
  testId: string;
  isLoggedIn: boolean;
  onSelectChunkPage?: (page: number, chunk: ReferencedChunk) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || loading) return;

    if (!isLoggedIn) {
      setErrorMsg("質問するにはログインが必要です。");
      return;
    }

    const nextUserMessage: ChatMessage = { role: "user", content: q };
    const historyPayload = messages.slice(-6).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setMessages((prev) => [...prev, nextUserMessage]);
    setInput("");
    setLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/papers/${testId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          history: historyPayload,
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(
          data?.error || `質問に失敗しました（ステータス: ${res.status}）`,
        );
      }

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: data.answer,
        referencedChunks: data.referencedChunks,
        notice: data.notice,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* やりとり表示エリア */}
      {messages.length > 0 ? (
        <div className="max-h-[500px] space-y-4 overflow-y-auto rounded-xl border border-zinc-200 bg-zinc-50/50 p-4">
          {messages.map((m, idx) => (
            <div
              key={idx}
              className={`flex flex-col ${
                m.role === "user" ? "items-end" : "items-start"
              }`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
                  m.role === "user"
                    ? "bg-zinc-900 text-white"
                    : "border border-zinc-200 bg-white text-zinc-900"
                }`}
              >
                <p className="whitespace-pre-wrap">{m.content}</p>

                {m.notice ? (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
                    {m.notice}
                  </div>
                ) : null}

                {/* 根拠チャンク（ページ番号） */}
                {m.referencedChunks && m.referencedChunks.length > 0 ? (
                  <div className="mt-3 border-t border-zinc-100 pt-2 text-xs">
                    <span className="font-medium text-zinc-500">根拠:</span>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {m.referencedChunks.map((chunk, ci) => {
                        if (chunk.pdf_page == null) return null;
                        return (
                          <button
                            key={ci}
                            type="button"
                            onClick={() => onSelectChunkPage?.(chunk.pdf_page!, chunk)}
                            className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800 transition hover:bg-sky-100 hover:text-sky-950"
                            title={`PDF p.${chunk.pdf_page} のハイライト表示を開く`}
                          >
                            <svg
                              className="h-3 w-3 text-sky-600"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                              />
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                              />
                            </svg>
                            p.{chunk.pdf_page} を開く
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {loading ? (
            <div className="flex items-start">
              <div className="inline-flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-500 shadow-sm">
                <span className="inline-block h-2 w-2 animate-ping rounded-full bg-zinc-400" />
                Gemini が回答を生成しています…
              </div>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>
      ) : null}

      {/* エラー表示 */}
      {errorMsg ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="leading-relaxed">{errorMsg}</p>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-xs text-red-600 hover:text-red-900"
            >
              閉じる
            </button>
          </div>
        </div>
      ) : null}

      {/* 質問入力欄 */}
      {isLoggedIn ? (
        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleSubmit(e);
                }
              }}
              placeholder="論文の内容について Gemini に質問する（例: この論文の主な主張は何ですか？）"
              rows={2}
              disabled={loading}
              className="flex-1 resize-y rounded-xl border border-zinc-200 bg-white p-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:bg-zinc-100"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="shrink-0 self-end rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
            >
              {loading ? "送信中…" : "質問する"}
            </button>
          </div>
        </form>
      ) : (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center">
          <p className="text-sm text-zinc-600">
            論文について Gemini に質問するには{" "}
            <Link className="font-semibold underline text-zinc-900 hover:text-zinc-700" href="/auth/login">
              ログイン
            </Link>{" "}
            してください。
          </p>
        </div>
      )}

      {/* 注意書き */}
      <p className="text-xs text-zinc-500">
        ※ Gemini の無料枠では入力が Google の改善に使われることがあります。やりとりはこのページを離れると消去されます。
      </p>
    </div>
  );
}
