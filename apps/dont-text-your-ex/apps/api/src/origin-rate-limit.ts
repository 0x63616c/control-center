import { isIP } from "node:net";
import type { Context, Next } from "hono";
import {
  RATE_LIMIT_CLASS,
  type RateLimitClass,
  rateLimitClasses,
} from "../../../contracts/rate-limit-policy";
import type { Env } from "./api";

const ORIGIN_RATE_LIMIT_CLASS = RATE_LIMIT_CLASS;

type OriginRateLimitClass = RateLimitClass;

export type OriginRateLimitResponse =
  | Readonly<{
      error: "rate_limited";
      routeClass: Exclude<OriginRateLimitClass, "invite">;
      retryAfterSeconds: number;
    }>
  | Readonly<{ error: "invite_rate_limited"; retryAfterSeconds: number }>;

type Budget = Readonly<{ capacity: number; windowMs: number }>;
export type OriginRateLimits = Readonly<Record<OriginRateLimitClass, Budget>>;

export const DEFAULT_ORIGIN_RATE_LIMITS: OriginRateLimits = {
  general: { capacity: 300, windowMs: 60_000 },
  auth: { capacity: 20, windowMs: 60_000 },
  invite: { capacity: 20, windowMs: 60_000 },
  reportEvidence: { capacity: 30, windowMs: 60_000 },
  mutation: { capacity: 120, windowMs: 60_000 },
};

type Bucket = { tokens: number; lastRefillAt: number; idleWindowMs: number };

const UNKNOWN_CLIENT = "unknown-client";
const DEFAULT_MAX_BUCKETS = 50_000;

function trustedClientSource(context: Context<Env>): string | null {
  const candidate = context.req.header("CF-Connecting-IP")?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : null;
}

function clientSource(context: Context<Env>): string {
  return trustedClientSource(context) ?? UNKNOWN_CLIENT;
}

export type OriginRateLimiter = {
  checkClient(context: Context<Env>): RateLimitResult;
  checkUser(context: Context<Env>): RateLimitResult;
};

type RateLimitResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly routeClass: OriginRateLimitClass;
      readonly retryAfterSeconds: number;
    };

export function createOriginRateLimiter(input: {
  readonly clock?: () => number;
  readonly limits: OriginRateLimits;
  readonly maxBuckets?: number;
}): OriginRateLimiter {
  const clock = input.clock ?? Date.now;
  const maxBuckets = Math.max(1, Math.floor(input.maxBuckets ?? DEFAULT_MAX_BUCKETS));
  const buckets = new Map<string, Bucket>();
  const sweepIntervalMs = Math.min(...Object.values(input.limits).map(({ windowMs }) => windowMs));
  let nextSweepAt = 0;

  function check(context: Context<Env>, source: string | null): RateLimitResult {
    if (source === null) return { allowed: true };
    const checkedAt = clock();
    if (checkedAt >= nextSweepAt) {
      for (const [key, bucket] of buckets) {
        if (checkedAt - bucket.lastRefillAt >= bucket.idleWindowMs) buckets.delete(key);
      }
      nextSweepAt = checkedAt + sweepIntervalMs;
    }
    const routeClasses = rateLimitClasses(context.req.method, context.req.path);
    const current = routeClasses.map((routeClass) => {
      const budget = input.limits[routeClass];
      const refillPerMs = budget.capacity / budget.windowMs;
      const key = `${routeClass}:${source}`;
      const previous = buckets.get(key) ?? {
        tokens: budget.capacity,
        lastRefillAt: checkedAt,
        idleWindowMs: budget.windowMs,
      };
      return {
        key,
        routeClass,
        refillPerMs,
        bucket: {
          tokens: Math.min(
            budget.capacity,
            previous.tokens + Math.max(0, checkedAt - previous.lastRefillAt) * refillPerMs,
          ),
          lastRefillAt: checkedAt,
          idleWindowMs: budget.windowMs,
        },
      };
    });
    const missing = current.filter(({ key }) => !buckets.has(key));
    if (buckets.size + missing.length > maxBuckets) {
      const slotsNeeded = buckets.size + missing.length - maxBuckets;
      const expirationTimes = [...buckets.values()]
        .map((bucket) => bucket.lastRefillAt + bucket.idleWindowMs)
        .sort((left, right) => left - right);
      const admissionAt = expirationTimes[slotsNeeded - 1] ?? checkedAt + sweepIntervalMs;
      return {
        allowed: false,
        routeClass: missing[0]?.routeClass ?? ORIGIN_RATE_LIMIT_CLASS.General,
        retryAfterSeconds: Math.max(1, Math.ceil((admissionAt - checkedAt) / 1000)),
      };
    }
    const denied = current.filter(({ bucket }) => bucket.tokens < 1);
    if (denied.length > 0) {
      for (const item of current) buckets.set(item.key, item.bucket);
      const deniedClass = denied[0]?.routeClass ?? ORIGIN_RATE_LIMIT_CLASS.General;
      return {
        allowed: false,
        routeClass: deniedClass,
        retryAfterSeconds: Math.max(
          ...denied.map(({ bucket, refillPerMs }) =>
            Math.ceil((1 - bucket.tokens) / refillPerMs / 1000),
          ),
        ),
      };
    }
    for (const item of current) {
      buckets.set(item.key, { ...item.bucket, tokens: item.bucket.tokens - 1 });
    }
    return { allowed: true };
  }

  return {
    checkClient(context) {
      // In-cluster probes do not carry a Cloudflare address and must remain
      // independent of public traffic. Public health calls do carry one and
      // consume the same general budget as every other public request.
      if (context.req.path === "/api/health" && trustedClientSource(context) === null) {
        return { allowed: true };
      }
      return check(context, `client:${clientSource(context)}`);
    },
    checkUser(context) {
      const userId = context.get("userId");
      return check(context, userId ? `user:${userId}` : null);
    },
  };
}

function rateLimitMiddleware(
  check: (limiter: OriginRateLimiter, context: Context<Env>) => RateLimitResult,
) {
  return (limiter: OriginRateLimiter) => {
    return async (context: Context<Env>, next: Next) => {
      const result = check(limiter, context);
      if (!result.allowed) {
        context.header("Retry-After", String(result.retryAfterSeconds));
        if (result.routeClass === ORIGIN_RATE_LIMIT_CLASS.Invite) {
          const body: OriginRateLimitResponse = {
            error: "invite_rate_limited",
            retryAfterSeconds: result.retryAfterSeconds,
          };
          return context.json(body, 429);
        }
        const body: OriginRateLimitResponse = {
          error: "rate_limited",
          routeClass: result.routeClass,
          retryAfterSeconds: result.retryAfterSeconds,
        };
        return context.json(body, 429);
      }
      await next();
    };
  };
}

export const originClientRateLimit = rateLimitMiddleware((limiter, context) =>
  limiter.checkClient(context),
);

export const originUserRateLimit = rateLimitMiddleware((limiter, context) =>
  limiter.checkUser(context),
);
