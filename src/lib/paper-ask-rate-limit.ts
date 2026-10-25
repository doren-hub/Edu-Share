const userTimestamps = new Map<string, number[]>();

export const ASK_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const ASK_RATE_LIMIT_MAX_REQUESTS = 6; // 6 requests per minute

export function checkUserAskRateLimit(userId: string): {
  allowed: boolean;
  retryAfterSeconds?: number;
} {
  const now = Date.now();
  const windowStart = now - ASK_RATE_LIMIT_WINDOW_MS;
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
