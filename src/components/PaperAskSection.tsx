"use client";

import { useState } from "react";
import { PaperAskChat, type ReferencedChunk } from "@/components/PaperAskChat";
import { QuizSessionPdfAnnotator } from "@/components/QuizSessionPdfAnnotator";
import { searchPhrasesFromSourceExcerpt, type PdfMarkItem } from "@/lib/quiz-pdf-marks";

export function PaperAskSection({
  testId,
  isLoggedIn,
}: {
  testId: string;
  isLoggedIn: boolean;
}) {
  const [activeMarks, setActiveMarks] = useState<PdfMarkItem[]>([]);
  const [activePage, setActivePage] = useState<number | null>(null);
  const [showAnnotator, setShowAnnotator] = useState(false);

  function handleSelectChunkPage(page: number, chunk: ReferencedChunk) {
    const phrases = searchPhrasesFromSourceExcerpt(chunk.content);
    const newMark: PdfMarkItem = {
      correct: true,
      phrases: phrases.length > 0 ? phrases : [chunk.content.slice(0, 100)],
      pdfPageHint: page,
      questionId: chunk.id,
    };

    setActiveMarks([newMark]);
    setActivePage(page);
    setShowAnnotator(true);

    // ハイライトビューへスムーズにスクロール
    setTimeout(() => {
      const annotatorContainer = document.getElementById("paper-pdf-annotator-container");
      annotatorContainer?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  return (
    <section className="mt-10 border-t border-zinc-100 pt-8" id="paper-ask-section">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-950">
            論文について Gemini に質問
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            論文の本文チャンクをもとに、Gemini が質問に回答します。根拠のページ番号をクリックすると PDF の該当箇所をハイライト表示します。
          </p>
        </div>
        {showAnnotator ? (
          <button
            type="button"
            onClick={() => setShowAnnotator(false)}
            className="text-xs font-medium text-zinc-600 underline hover:text-zinc-900"
          >
            PDFハイライト表示を閉じる
          </button>
        ) : null}
      </div>

      <div className="mt-6">
        <PaperAskChat
          testId={testId}
          isLoggedIn={isLoggedIn}
          onSelectChunkPage={handleSelectChunkPage}
        />
      </div>

      {showAnnotator ? (
        <div
          id="paper-pdf-annotator-container"
          className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
            <h3 className="text-sm font-semibold text-zinc-950">
              教材 PDF（根拠ハイライト表示{activePage ? `: p.${activePage}` : ""}）
            </h3>
            <button
              type="button"
              onClick={() => setShowAnnotator(false)}
              className="text-xs text-zinc-500 hover:text-zinc-800"
            >
              閉じる
            </button>
          </div>
          <div className="mt-4">
            <QuizSessionPdfAnnotator
              testId={testId}
              markItems={activeMarks}
              targetPage={activePage}
              emptyMessage="質問の回答から根拠ページをクリックすると、該当箇所のハイライトが表示されます。"
              legendLabelCorrect="根拠箇所"
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
