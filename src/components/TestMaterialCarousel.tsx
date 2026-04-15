"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type MaterialCarouselPane =
  | { key: "pdf"; label: string; pdfSrc: string }
  | { key: "slide"; label: string; slideSrc: string }
  | { key: "video"; label: string; videoSrc: string };

export function TestMaterialCarousel({
  title,
  panes,
}: {
  title: string;
  panes: MaterialCarouselPane[];
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const recomputeActive = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || panes.length === 0) return;
    const w = el.clientWidth;
    if (w <= 0) return;
    const idx = Math.round(el.scrollLeft / w);
    setActive(Math.min(Math.max(0, idx), panes.length - 1));
  }, [panes.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    recomputeActive();
    el.addEventListener("scroll", recomputeActive, { passive: true });
    window.addEventListener("resize", recomputeActive);
    return () => {
      el.removeEventListener("scroll", recomputeActive);
      window.removeEventListener("resize", recomputeActive);
    };
  }, [recomputeActive]);

  function scrollToIndex(i: number) {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  }

  if (panes.length === 0) return null;

  return (
    <div className="space-y-2">
      <div
        ref={scrollerRef}
        className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth rounded-lg border border-zinc-200 bg-zinc-100/80 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {panes.map((pane) => (
          <div
            key={pane.key}
            className="w-full shrink-0 snap-center snap-always"
            style={{ minWidth: "100%" }}
          >
            <div className="flex h-[min(75vh,880px)] flex-col bg-white">
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-zinc-50 px-3 py-2">
                <span className="text-xs font-medium text-zinc-700">{pane.label}</span>
                {pane.key === "pdf" ? (
                  <a
                    href={pane.pdfSrc}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-sky-800 underline hover:text-sky-950"
                  >
                    新しいタブで開く
                  </a>
                ) : pane.key === "slide" ? (
                  <a
                    href={pane.slideSrc}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-sky-800 underline hover:text-sky-950"
                  >
                    新しいタブで開く
                  </a>
                ) : (
                  <a
                    href={pane.videoSrc}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-sky-800 underline hover:text-sky-950"
                  >
                    新しいタブで開く
                  </a>
                )}
              </div>
              <div className="min-h-0 flex-1">
                {pane.key === "pdf" ? (
                  <iframe
                    title={`${title}（PDF）`}
                    src={pane.pdfSrc}
                    className="h-full min-h-[min(70vh,820px)] w-full bg-zinc-50"
                  />
                ) : pane.key === "slide" ? (
                  <iframe
                    title={`${title}（スライド PDF）`}
                    src={pane.slideSrc}
                    className="h-full min-h-[min(70vh,820px)] w-full bg-zinc-50"
                  />
                ) : (
                  <video
                    title={`${title}（動画）`}
                    src={pane.videoSrc}
                    controls
                    playsInline
                    className="h-full min-h-[min(70vh,820px)] w-full bg-black object-contain"
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {panes.length > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <p className="text-xs text-zinc-500">横にスワイプ（またはドラッグ）で切り替え</p>
          <div className="flex items-center gap-1.5">
            {panes.map((p, i) => (
              <button
                key={p.key}
                type="button"
                aria-label={`${p.label}を表示`}
                aria-current={i === active ? "true" : undefined}
                onClick={() => scrollToIndex(i)}
                className={`h-2 rounded-full transition-all ${
                  i === active ? "w-6 bg-zinc-800" : "w-2 bg-zinc-300 hover:bg-zinc-400"
                }`}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
