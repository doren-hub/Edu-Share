/**
 * LLM を呼ぶ API のユーザー単位レート制限（プロセス内メモリ、固定窓ではなくスライディング窓）。
 * 制限値はここで一元管理する。説明は docs/api-input-limits.md を参照。
 */
export const LLM_RATE_LIMITS = {
  /** POST /api/tests/[id]/start（出題生成） */
  quizStart: { windowMs: 60 * 1000, maxRequests: 10 },
  /** POST /api/quiz/[sessionId]/submit（記述採点） */
  quizSubmit: { windowMs: 60 * 1000, maxRequests: 10 },
  /** POST /api/tests/upload/summarize と /api/tests/[id]/summarize（共通の枠） */
  summarize: { windowMs: 60 * 1000, maxRequests: 5 },
} as const;

export type LlmRateLimitKind = keyof typeof LLM_RATE_LIMITS;

const buckets = new Map<LlmRateLimitKind, Map<string, number[]>>();

export function checkLlmRateLimit(
  kind: LlmRateLimitKind,
  userId: string,
  now: number = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const { windowMs, maxRequests } = LLM_RATE_LIMITS[kind];
  let users = buckets.get(kind);
  if (!users) {
    users = new Map();
    buckets.set(kind, users);
  }
  const windowStart = now - windowMs;

  // 期限切れユーザーの整理（メモリ肥大化防止）
  for (const [uid, list] of users) {
    const fresh = list.filter((t) => t > windowStart);
    if (fresh.length === 0) users.delete(uid);
    else if (fresh.length !== list.length) users.set(uid, fresh);
  }

  const valid = users.get(userId) ?? [];
  if (valid.length >= maxRequests) {
    const retryAfter = Math.ceil((valid[0]! + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
  }
  valid.push(now);
  users.set(userId, valid);
  return { allowed: true };
}

/** 制限超過時は 429 + Retry-After を返す。許可なら null。 */
export function llmRateLimitResponse(kind: LlmRateLimitKind, userId: string): Response | null {
  const rate = checkLlmRateLimit(kind, userId);
  if (rate.allowed) return null;
  // next/server を import しないことで node --test から直接読み込める。
  return Response.json(
    {
      error: "リクエストの回数制限に達しました。少し待ってから再度お試しください。",
      retryAfterSeconds: rate.retryAfterSeconds,
    },
    { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
  );
}

export function resetLlmRateLimitForTests(): void {
  buckets.clear();
}
