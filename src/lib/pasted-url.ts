import type { ClipboardEvent } from "react";

/**
 * アドレスバーやチャットからコピーした URL を入力欄向けに整える。
 * 改行・前後の空白・<> 囲みがあると type=url では貼り付け自体が捨てられる。
 */
export function sanitizePastedUrl(raw: string): string {
  let t = raw.replace(/\u00a0/g, " ").trim();
  if (!t) return "";
  t = t.replace(/^[<\u300c\u300e]+/, "").replace(/[>\u300d\u300f]+$/, "").trim();
  const m = t.match(/https?:\/\/[^\s<>"']+/i);
  if (m?.[0]) {
    return m[0].replace(/[.,);]+$/g, "");
  }
  return t.replace(/\s+/g, "").trim();
}

export function applyUrlInputPaste(
  e: ClipboardEvent<HTMLInputElement>,
  setValue: (value: string) => void,
): void {
  const text =
    e.clipboardData?.getData("text/plain") ||
    e.clipboardData?.getData("text") ||
    "";
  if (!text.trim()) return;
  e.preventDefault();
  setValue(sanitizePastedUrl(text));
}
