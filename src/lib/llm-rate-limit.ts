/** Shared sliding-window limits. Keep all LLM API budgets here. */
export const LLM_RATE_LIMITS = {
  ask: { windowMs: 60_000, maxRequests: 6 },
  quizStart: { windowMs: 60_000, maxRequests: 10 },
  quizSubmit: { windowMs: 60_000, maxRequests: 10 },
  // Both summary routes consume this same budget.
  summarize: { windowMs: 60_000, maxRequests: 5 },
} as const;
export type LlmRateLimitKind = keyof typeof LLM_RATE_LIMITS;
export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number };
export type SharedRateLimitStore = {
  consume(kind: LlmRateLimitKind, userId: string, limit: { windowMs: number; maxRequests: number }): Promise<RateLimitDecision>;
};

/** Dependency injection keeps tests offline; production never falls back to local counters. */
export function createLlmRateLimiter(store: SharedRateLimitStore) {
  return async function llmRateLimitResponse(kind: LlmRateLimitKind, userId: string): Promise<Response | null> {
    try {
      const rate = await store.consume(kind, userId, LLM_RATE_LIMITS[kind]);
      if (typeof rate.allowed !== "boolean" || !Number.isInteger(rate.retryAfterSeconds) ||
          rate.retryAfterSeconds < 0 || (!rate.allowed && rate.retryAfterSeconds < 1)) {
        throw new Error("Invalid rate limit decision");
      }
      if (rate.allowed) return null;
      return Response.json({
        error: "リクエストの回数制限に達しました。少し待ってから再度お試しください。",
        retryAfterSeconds: rate.retryAfterSeconds,
      }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } });
    } catch {
      // Do not expose database details or allow unmetered LLM calls during an outage.
      return Response.json({ error: "回数制限の確認に失敗しました。少し待ってから再度お試しください。" },
        { status: 503, headers: { "Retry-After": "5" } });
    }
  };
}

type RpcClient = {
  rpc(name: string, params: Record<string, unknown>): {
    abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
  };
};

export function createSharedRateLimitStore(client: () => Promise<RpcClient>): SharedRateLimitStore {
  return {
    async consume(kind, userId, limit) {
      const { data, error } = await (await client()).rpc("consume_llm_rate_limit", {
        p_user_id: userId, p_kind: kind,
        p_window_ms: limit.windowMs, p_max_requests: limit.maxRequests,
      }).abortSignal(AbortSignal.timeout(5000));
      if (error || !data || typeof data !== "object" ||
          !("allowed" in data) || typeof data.allowed !== "boolean" ||
          !("retry_after_seconds" in data) || typeof data.retry_after_seconds !== "number") {
        throw new Error("Shared rate limit unavailable");
      }
      return { allowed: data.allowed, retryAfterSeconds: data.retry_after_seconds };
    },
  };
}

export const llmRateLimitResponse = createLlmRateLimiter(createSharedRateLimitStore(async () => {
  const { createAdminClient } = await import("./supabase/admin");
  return createAdminClient();
}));
