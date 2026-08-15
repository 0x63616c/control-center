import type { Context, Next } from "hono";
import type { Env } from "./api";

const CAPACITY = 20;
const WINDOW_MS = 60_000;
const REFILL_PER_MS = CAPACITY / WINDOW_MS;

type Bucket = {
  tokens: number;
  lastRefillAt: number;
};

type ProbeLimiter = {
  check: (
    sources: readonly string[],
    checkedAt?: number,
  ) => { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };
};

export function createInviteProbeLimiter(): ProbeLimiter {
  const buckets = new Map<string, Bucket>();
  let nextSweepAt = 0;

  return {
    check(sources, checkedAt = Date.now()) {
      if (checkedAt >= nextSweepAt) {
        for (const [source, bucket] of buckets) {
          if (checkedAt - bucket.lastRefillAt >= WINDOW_MS) buckets.delete(source);
        }
        nextSweepAt = checkedAt + WINDOW_MS;
      }
      const current = sources.map((source) => {
        const previous = buckets.get(source) ?? { tokens: CAPACITY, lastRefillAt: checkedAt };
        return {
          source,
          bucket: {
            tokens: Math.min(
              CAPACITY,
              previous.tokens + Math.max(0, checkedAt - previous.lastRefillAt) * REFILL_PER_MS,
            ),
            lastRefillAt: checkedAt,
          },
        };
      });
      const denied = current.filter(({ bucket }) => bucket.tokens < 1);
      if (denied.length > 0) {
        for (const { source, bucket } of current) buckets.set(source, bucket);
        const retryAfterSeconds = Math.max(
          ...denied.map(({ bucket }) => Math.ceil((1 - bucket.tokens) / REFILL_PER_MS / 1000)),
        );
        return { allowed: false, retryAfterSeconds };
      }
      for (const { source, bucket } of current) {
        buckets.set(source, { ...bucket, tokens: bucket.tokens - 1 });
      }
      return { allowed: true };
    },
  };
}

function clientIp(context: Context<Env>): string | null {
  const cloudflare = context.req.header("CF-Connecting-IP")?.trim();
  if (cloudflare) return cloudflare;
  const forwarded = context.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return context.req.header("X-Real-IP")?.trim() || null;
}

export function inviteProbeRateLimit(limiter: ProbeLimiter) {
  return async (context: Context<Env>, next: Next) => {
    const userId = context.get("userId");
    const ip = clientIp(context);
    const sources = [userId ? `user:${userId}` : null, ip ? `ip:${ip}` : null].filter(
      (source): source is string => source !== null,
    );
    if (sources.length > 0) {
      const result = limiter.check(sources);
      if (!result.allowed) {
        context.header("Retry-After", String(result.retryAfterSeconds));
        return context.json(
          { error: "invite_rate_limited" as const, retryAfterSeconds: result.retryAfterSeconds },
          429,
        );
      }
    }
    await next();
  };
}
