import { createLogger } from "@www/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { api, type Env } from "./api";
import { authMiddleware } from "./auth";
import { createInviteProbeLimiter, inviteProbeRateLimit } from "./invite-rate-limit";

const log = createLogger({ service: "dont-text-your-ex-api" });

// Allowed origins: prod web app, local Vite dev server, local Vite preview, Capacitor iOS shell.
// VITE_API_BASE is the prod URL; add localhost variants for local dev.
const ALLOWED_ORIGINS = [
  "https://dont-text-your-ex.worldwidewebb.co",
  "http://localhost:5173",
  "http://localhost:4173",
  "capacitor://localhost",
];

export function buildApp(): Hono<Env> {
  const app = new Hono<Env>();
  const inviteLimiter = createInviteProbeLimiter();

  // Request log: proves whether a call (e.g. the native /auth/apple) actually
  // reaches the api and from which origin, with status + latency.
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    log.info(
      {
        method: c.req.method,
        path: c.req.path,
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

  app.use("/api/*", authMiddleware);
  app.use("/api/jars/code/*", inviteProbeRateLimit(inviteLimiter));
  app.use("/api/jars/join", inviteProbeRateLimit(inviteLimiter));
  app.route("/api", api);

  return app;
}
