const userTimestamps = new Map<string, number[]>();

export const ASK_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const ASK_RATE_LIMIT_MAX_REQUESTS = 6; // 6 requests per minute

export function checkUserAskRateLimit(userId: string): {
  allowed: boolean;
  retryAfterSeconds?: number;
} {
  const now = Date.now();
  const windowStart = now - ASK_RATE_LIMIT_WINDOW_MS;

  // 期限切れユーザーの整理（メモリ肥大化防止）
  for (const [uid, tsList] of userTimestamps.entries()) {
    const fresh = tsList.filter((t) => t > windowStart);
    if (fresh.length === 0) {
      userTimestamps.delete(uid);
    } else if (fresh.length !== tsList.length) {
      userTimestamps.set(uid, fresh);
    }
  }

  const existing = userTimestamps.get(userId) ?? [];
  const valid = existing.filter((t) => t > windowStart);

  if (valid.length >= ASK_RATE_LIMIT_MAX_REQUESTS) {
    const oldest = valid[0]!;
    const retryAfter = Math.ceil((oldest + ASK_RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfter) };
  }

  valid.push(now);
  userTimestamps.set(userId, valid);
  return { allowed: true };
}

export function resetUserAskRateLimitForTests(): void {
  userTimestamps.clear();
}
