// Offline route-test fixture only. Production uses the PostgreSQL RPC.
import { createLlmRateLimiter, LLM_RATE_LIMITS, type LlmRateLimitKind } from "./llm-rate-limit.ts";
export { LLM_RATE_LIMITS };
const buckets = new Map<string, number[]>();
export function resetLlmRateLimitForTests() { buckets.clear(); }
export function checkLlmRateLimit(kind: LlmRateLimitKind, userId: string, now = Date.now()) {
  const { windowMs, maxRequests } = LLM_RATE_LIMITS[kind];
  const key = `${userId}:${kind}`;
  const fresh = (buckets.get(key) ?? []).filter(t => t > now - windowMs);
  if (fresh.length >= maxRequests) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((fresh[0] + windowMs - now) / 1000)) };
  buckets.set(key, [...fresh, now]);
  return { allowed: true, retryAfterSeconds: 0 };
}
export const llmRateLimitResponse = createLlmRateLimiter({
  async consume(kind, userId) { return checkLlmRateLimit(kind, userId); },
});
