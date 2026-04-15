import type { StoredQuestion } from "@/lib/types";

export function isStoredQuestionLike(x: unknown): x is StoredQuestion {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o.type === "multiple_choice") {
    const opts = o.options;
    return (
      typeof o.id === "string" &&
      typeof o.prompt === "string" &&
      Array.isArray(opts) &&
      opts.length >= 2 &&
      opts.every((t) => typeof t === "string") &&
      typeof o.correctIndex === "number"
    );
  }
  if (o.type === "essay") {
    return typeof o.id === "string" && typeof o.prompt === "string";
  }
  return false;
}
