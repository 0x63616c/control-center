import { createLogger } from "@www/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { api, type Env } from "./api";
import { authMiddleware } from "./auth";
import {
  createOriginRateLimiter,
  DEFAULT_ORIGIN_RATE_LIMITS,
  type OriginRateLimits,
  originClientRateLimit,
  originUserRateLimit,
} from "./origin-rate-limit";
import { privacySafeRequestPath } from "./request-log-path";

const log = createLogger({ service: "dont-text-your-ex-api" });

// Allowed origins: prod web app, local Vite dev server, local Vite preview, Capacitor iOS shell.
// VITE_API_BASE is the prod URL; add localhost variants for local dev.
const ALLOWED_ORIGINS = [
  "https://dont-text-your-ex.worldwidewebb.co",
  "http://localhost:5173",
  "http://localhost:4173",
  "capacitor://localhost",
];

export type BuildAppOptions = Readonly<{
  rateLimit?: Readonly<{
    clock?: () => number;
    limits?: OriginRateLimits;
    maxBuckets?: number;
  }>;
}>;

export function buildApp(options: BuildAppOptions = {}): Hono<Env> {
  const app = new Hono<Env>();
  const limiter = createOriginRateLimiter({
    clock: options.rateLimit?.clock,
    limits: options.rateLimit?.limits ?? DEFAULT_ORIGIN_RATE_LIMITS,
    maxBuckets: options.rateLimit?.maxBuckets,
  });

  // Request log: proves whether a call (e.g. the native /auth/apple) actually
  // reaches the api and from which origin, with status + latency.
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    // Kubernetes probes are intentionally quiet; public health traffic is
    // still bounded by the edge and trusted-client origin limiter.
    if (c.req.path === "/api/health") return;
    log.info(
      {
        method: c.req.method,
        path: privacySafeRequestPath(c.req.path),
        status: c.res.status,
        ms: Date.now() - start,
        origin: c.req.header("Origin") ?? null,
      },
      "request",
    );
  });

  app.use(
    "*",
    cors({
      origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );

  app.use("/api/*", originClientRateLimit(limiter));
  app.use("/api/*", authMiddleware);
  app.use("/api/*", originUserRateLimit(limiter));
  app.route("/api", api);

  return app;
}
