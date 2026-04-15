"use client";

/**
 * クイズ結果 PDF のハイライト表示。
 *
 * 【照合】NFKC 正規化＋空白圧縮＋小文字化した文字列同士で比較する（全角半角の差を吸収）。
 *       ページ全体を1本の文字列にして indexOf するのは行わない。
 *       連続する textContent.items の str を「窓」ごとに結合し、その窓内だけで区間を求める。
 *
 * 【座標】正規化後の文字列には一切触れず、元の item.str / transform / width / height から
 *         各 TextItem の部分区間 [s,e) ごとに PDF 空間の帯を計算し、page.getViewport({scale}) で
 *         ビューポート（＝キャンバス／画像の CSS ピクセル）へ変換する。
 *
 * 【描画】PDF はラスタ画像のみ生成。ハイライトは画像上に absolute な div を重ね、
 *         left/top/width/height はページ寸法に対する % で指定し max-w-full 縮小と一致させる。
 */

import { useEffect, useRef, useState } from "react";
import type { PDFPageProxy } from "pdfjs-dist";
import {
  type TextItemLike,
  collectViewportQuadsPerMatchedRun,
  finalizeViewportHighlightsForPage,
  findMatchInItemWindows,
  isPlausibleViewportHighlight,
  viewportCssRectFromPdf,
} from "@/lib/pdf-highlight-geometry";
import type { PdfMarkItem } from "@/lib/quiz-pdf-marks";

/** PDF レンダリングと convertToViewportRectangle の基準スケール（CSS px と一致させる） */
const RENDER_SCALE = 1.35;
const MAX_PAGES = 60;

/** 1 ページ分：背景画像＋重ねる quad（いずれも viewport ピクセル座標・画像左上が原点） */
type PageView = {
  imageUrl: string;
  w: number;
  h: number;
  /** ハイライト1ブロック＝1 div。同一 text run 内のマッチ帯（viewport ピクセル、% 描画時の基準寸法は w,h）。 */
  quads: { left: number; top: number; width: number; height: number; correct: boolean }[];
};

export function QuizSessionPdfAnnotator({
  testId,
  markItems,
}: {
  testId: string;
  markItems: PdfMarkItem[];
}) {
  const [status, setStatus] = useState<
    "idle" | "loading" | "ready" | "error" | "nomatch"
  >("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [pages, setPages] = useState<PageView[]>([]);
  const [viewMode, setViewMode] = useState<"annotated" | "original">("annotated");
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    if (markItems.length === 0) {
      setStatus("nomatch");
      return;
    }

    let cancelled = false;
    blobUrlsRef.current = [];

    void (async () => {
      setStatus("loading");
      setErrMsg(null);
      setPages([]);

      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

        const res = await fetch(`/api/tests/${testId}/pdf`, {
          credentials: "include",
        });
        if (!res.ok) {
          throw new Error(
            res.status === 401 ? "ログインが必要です" : "PDF を取得できませんでした",
          );
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        const doc = await pdfjs
          .getDocument({ data: new Uint8Array(buf), useSystemFonts: true })
          .promise;
        const n = Math.min(doc.numPages, MAX_PAGES);

        type CachedPage = {
          page: PDFPageProxy;
          viewport: ReturnType<PDFPageProxy["getViewport"]>;
          items: TextItemLike[];
        };

        const pageCache: CachedPage[] = [];
        /** 各ページに載せる quad 一覧（後から画像と重ねる） */
        const quadsPerPage: PageView["quads"][] = Array.from({ length: n }, () => []);
        const seen = new Set<string>();
        const resolvedQuestion = new Set<string>();

        const markUsesPageHint = (mark: PdfMarkItem): boolean => {
          const h = mark.pdfPageHint;
          return (
            h != null &&
            Number.isFinite(h) &&
            h >= 1 &&
            h <= n &&
            mark.phrases.length > 0
          );
        };

        for (let pageNum = 1; pageNum <= n; pageNum++) {
          if (cancelled) break;
          const page = await doc.getPage(pageNum);
          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const textContent = await page.getTextContent();
          const items: TextItemLike[] = [];
          for (const it of textContent.items) {
            if (typeof it !== "object" || !it || !("str" in it)) continue;
            const o = it as Record<string, unknown>;
            if (typeof o.str !== "string") continue;
            if (!Array.isArray(o.transform)) continue;
            if (typeof o.width !== "number") continue;
            const height = typeof o.height === "number" ? o.height : 0;
            items.push({
              str: o.str,
              transform: o.transform as number[],
              width: o.width,
              height,
            });
          }
          pageCache[pageNum - 1] = { page, viewport, items };
        }

        const tryMarksOnPage = (pageNum: number, mode: "hint-first" | "hint-fallback-all") => {
          const { viewport, items } = pageCache[pageNum - 1]!;
          for (let mi = 0; mi < markItems.length; mi++) {
            const mark = markItems[mi]!;
            const qid = mark.questionId ?? `__${mi}`;
            if (mode === "hint-fallback-all") {
              if (!markUsesPageHint(mark)) continue;
              if (resolvedQuestion.has(qid)) continue;
            } else if (
              markUsesPageHint(mark) &&
              pageNum !== mark.pdfPageHint &&
              !(mark.pdfHighlightRects && mark.pdfHighlightRects.length > 0)
            ) {
              continue;
            }

            /** 出題時にサーバーで解決済みの矩形があればテキスト照合をスキップ（同一 RENDER_SCALE で viewport 変換） */
            if (mark.pdfHighlightRects?.length) {
              let placed = false;
              for (let ri = 0; ri < mark.pdfHighlightRects.length; ri++) {
                const hr = mark.pdfHighlightRects[ri]!;
                if (hr.page !== pageNum) continue;
                const css = viewportCssRectFromPdf(viewport, hr.pdfRect);
                if (css.width < 0.2 || css.height < 0.2) continue;
                if (!isPlausibleViewportHighlight(css, viewport.width, viewport.height)) continue;
                const key = `${qid}-${pageNum}-srv-${ri}-${hr.pdfRect.join(",")}`;
                if (seen.has(key)) continue;
                seen.add(key);
                quadsPerPage[pageNum - 1]!.push({ ...css, correct: mark.correct });
                placed = true;
              }
              if (placed) resolvedQuestion.add(qid);
              continue;
            }

            const phrases = [...mark.phrases].sort((a, b) => b.length - a.length);
            for (const phrase of phrases) {
              const found = findMatchInItemWindows(items, phrase);
              if (!found) continue;
              const { chunk, u, v, joinMode } = found;
              const rects = collectViewportQuadsPerMatchedRun(chunk, u, v, viewport, joinMode);
              if (rects.length === 0) continue;
              const key = `${qid}-${pageNum}-${u}-${v}-${mark.correct}-${joinMode}`;
              if (seen.has(key)) {
                resolvedQuestion.add(qid);
                break;
              }
              seen.add(key);
              for (const r of rects) {
                quadsPerPage[pageNum - 1]!.push({ ...r, correct: mark.correct });
              }
              resolvedQuestion.add(qid);
              break;
            }
          }
        };

        for (let pageNum = 1; pageNum <= n; pageNum++) {
          if (cancelled) break;
          tryMarksOnPage(pageNum, "hint-first");
        }
        for (let pageNum = 1; pageNum <= n; pageNum++) {
          if (cancelled) break;
          tryMarksOnPage(pageNum, "hint-fallback-all");
        }

        const out: PageView[] = [];
        for (let pageNum = 1; pageNum <= n; pageNum++) {
          if (cancelled) break;
          const { page, viewport } = pageCache[pageNum - 1]!;
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvas を初期化できませんでした");
          await page.render({ canvasContext: ctx, viewport }).promise;

          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob((b) => resolve(b), "image/png"),
          );
          if (!blob) throw new Error("ページ画像の生成に失敗しました");
          const imageUrl = URL.createObjectURL(blob);
          blobUrlsRef.current.push(imageUrl);

          out.push({
            imageUrl,
            w: viewport.width,
            h: viewport.height,
            quads: finalizeViewportHighlightsForPage(
              quadsPerPage[pageNum - 1] ?? [],
              viewport.width,
              viewport.height,
            ),
          });
        }

        if (cancelled) {
          for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
          blobUrlsRef.current = [];
          return;
        }

        setPages(out);
        const any = quadsPerPage.some((q) => q.length > 0);
        setStatus(any ? "ready" : "nomatch");
      } catch (e) {
        for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
        blobUrlsRef.current = [];
        if (!cancelled) {
          setErrMsg(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
      blobUrlsRef.current = [];
    };
  }, [testId, markItems]);

  if (markItems.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        設問データがないため、PDF へのマーカー表示はできません。
      </p>
    );
  }

  const showPdfChrome =
    (status === "ready" || status === "nomatch") && pages.length > 0;
  const pdfUrl = `/api/tests/${testId}/pdf`;

  return (
    <div className="space-y-3">
      {showPdfChrome ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            className="inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5 text-sm shadow-sm"
            role="tablist"
            aria-label="PDF の表示切替"
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "annotated"}
              className={`rounded-md px-3 py-1.5 font-medium transition ${
                viewMode === "annotated"
                  ? "bg-white text-zinc-900 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
              onClick={() => setViewMode("annotated")}
            >
              マーカー付き
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "original"}
              className={`rounded-md px-3 py-1.5 font-medium transition ${
                viewMode === "original"
                  ? "bg-white text-zinc-900 shadow-sm"
                  : "text-zinc-600 hover:text-zinc-900"
              }`}
              onClick={() => setViewMode("original")}
            >
              元のPDF
            </button>
          </div>
          {viewMode === "annotated" ? (
            <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-3 w-6 rounded-sm bg-blue-500/55 ring-1 ring-blue-600/30" />
                正解
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-3 w-6 rounded-sm bg-red-500/55 ring-1 ring-red-600/30" />
                不正解・記述未満
              </span>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">
              ブラウザの PDF 表示（拡大・コピーなどはこちら）
            </p>
          )}
        </div>
      ) : null}

      {status === "loading" ? (
        <p className="text-sm text-zinc-500">PDF を読み込み、テキスト位置を照合しています…</p>
      ) : null}
      {status === "error" ? (
        <p className="text-sm text-red-700">{errMsg ?? "読み込みに失敗しました"}</p>
      ) : null}
      {status === "nomatch" ? (
        <div
          className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900"
          role="alert"
        >
          <p className="text-sm font-semibold">マーカーを表示できませんでした</p>
          <p className="text-sm leading-relaxed">
            PDF から読み取ったテキストと、根拠抜粋（旧データでは設問文）を照合できませんでした。教材は「元のPDF」でご確認ください。
          </p>
        </div>
      ) : null}

      {showPdfChrome && viewMode === "original" ? (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 shadow-sm">
          <iframe
            title="元のPDF"
            src={pdfUrl}
            className="h-[min(78vh,900px)] w-full border-0 bg-white"
          />
        </div>
      ) : null}

      {showPdfChrome && viewMode === "annotated" ? (
        <div className="max-h-[min(78vh,900px)] space-y-6 overflow-y-auto rounded-xl border border-zinc-200 bg-zinc-100/80 p-4">
          {pages.map((pg, idx) => (
            <div key={idx} className="relative mx-auto w-full max-w-full shadow-sm">
              {/*
                画像は max-w-full で縮む。quad は viewport ピクセルで保持し、
                オーバーレイは inset-0 ＋ % で縮小後の画像に一致させる。
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pg.imageUrl}
                alt={`PDF p.${idx + 1}`}
                width={pg.w}
                height={pg.h}
                className="block h-auto w-full bg-white"
              />
              <div className="pointer-events-none absolute inset-0" aria-hidden>
                {pg.quads.map((q, qi) => (
                  <div
                    key={qi}
                    className={`absolute box-border rounded-[1px] outline outline-1 [outline-offset:-1px] ${
                      q.correct
                        ? "bg-blue-500/35 outline-blue-700/50"
                        : "bg-red-500/35 outline-red-700/50"
                    }`}
                    style={{
                      left: `${(q.left / pg.w) * 100}%`,
                      top: `${(q.top / pg.h) * 100}%`,
                      width: `${(q.width / pg.w) * 100}%`,
                      height: `${(q.height / pg.h) * 100}%`,
                    }}
                  />
                ))}
              </div>
              <p className="mt-1 text-center text-xs text-zinc-500">p.{idx + 1}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
