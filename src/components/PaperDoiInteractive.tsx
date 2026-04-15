"use client";

import { normalizePaperDoiDisplay, paperDoiHref } from "@/lib/paper-doi";

type Props = {
  paperDoi: string | null | undefined;
  compact?: boolean;
  className?: string;
};

/**
 * Use a button + window.open when the row is wrapped in Next.js &lt;Link&gt;
 * so we do not nest &lt;a&gt; inside &lt;a&gt;.
 */
export function PaperDoiInteractive({
  paperDoi,
  compact,
  className,
}: Props) {
  const d = normalizePaperDoiDisplay(paperDoi);
  if (!d) return null;
  const href = paperDoiHref(d);
  const style =
    className ??
    (compact
      ? "inline font-mono font-medium text-violet-700 underline decoration-violet-400/80 hover:text-violet-900"
      : "inline font-mono font-medium text-violet-700 underline decoration-violet-400/80 hover:text-violet-900");

  return (
    <button
      type="button"
      className={`${style} cursor-pointer border-0 bg-transparent p-0 text-left`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(href, "_blank", "noopener,noreferrer");
      }}
    >
      {d}
    </button>
  );
}
