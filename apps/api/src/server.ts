// BOOT FIRST: boot-env hydrates /run/secrets/* into process.env, derives
// DATABASE_URL, and fail-fast validates required prod env — all at module-eval.
// It MUST evaluate before any @features/* import below: feature deps/db modules
// construct pools + HA clients at module top, so the first lazy config read
// happens during the static-import phase. Biome's organizeImports keeps this
// bare side-effect import pinned at top as a leading barrier. See design spec §5.6.
import "./boot-env";
import { GENERATED_ROUTES } from "@features/_generated/http.gen";
import { backfillWakePhotoIndex } from "@features/wakes/photos";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createLogger, installFatalHandlers } from "@www/logger";
import { ENV as config } from "@www/platform/env";
import { db } from "./db/index";
import { runMigrations } from "./db/migrate";
import { startGuestServer } from "./guest-server";
import { findRoute } from "./http/route-table";
import { migratePhotoPaths } from "./startup/photo-path-migration";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/routers/index";

// Root logger, created ONCE at process startup, bound to every line in this
// process. Domain services use getLogger() (see docs/logging.md §2).
const log = createLogger({ service: "api" });

// An escaping async throw or an untracked rejected promise otherwise kills
// this process with zero structured output; see docs/logging.md.
installFatalHandlers(log);

// Deploys reach this box automatically: push to main -> CI builds the image ->
// the cluster rolls the service to the new digest (www-a8p).
//
// Apply pending SQL migrations before accepting traffic. Uses drizzle-orm's
// runtime migrator (not drizzle-kit), so the production image ships no build
// toolchain. runMigrations() logs start/done internally; we only need to
// surface the error here (it rethrows, so Swarm crash-backoff retries until
// postgres is reachable and migrated).
try {
  await runMigrations();
} catch (err) {
  log.error({ err }, "migrations failed");
  throw err;
}

// Guest (captive-portal) listener, ADR-0006: a second, portal-only Bun.serve
// bound to the LAN guest network. Fully optional , GUEST_PORT unset (the
// default) means this never starts, so dev/test and any deploy that hasn't
// wired the guest network yet boot exactly as before.
if (config.GUEST_PORT) {
  startGuestServer({
    port: config.GUEST_PORT,
    tlsDir: config.GUEST_TLS_DIR,
    // Dev default: the built guest bundle sits alongside the web product
    // (web/dist-portal/, relative to this api
    // product's cwd). The production image sets GUEST_STATIC_DIR explicitly
    // to the path Task 4's Dockerfile COPYs it to.
    staticDir: config.GUEST_STATIC_DIR ?? "../web/dist-portal",
    httpPort: config.GUEST_HTTP_PORT,
  });
}

// Move any photos still under the legacy YYYY/MM/DD tree onto flat ISO-instant
// names. Idempotent and a no-op once done, so it rides the same boot hook as
// the backfill below , which must run AFTER it, since the backfill only
// recognises the flat scheme.
try {
  const migrated = await migratePhotoPaths(db);
  if (migrated.wake + migrated.booth + migrated.orphans > 0) {
    log.info(migrated, "migrated photo paths to flat ISO names");
  }
} catch (err) {
  // Non-fatal: legacy paths keep serving (the serve route is shape-agnostic),
  // and the next boot retries.
  log.error({ err }, "photo path migration failed");
}

// Index any wake photos that predate the wake_photo table (or that a failed
// row insert left unindexed). Idempotent, so running on every boot is the
// cheapest way to guarantee the index converges on the filesystem's truth.
try {
  const backfilled = await backfillWakePhotoIndex(db);
  if (backfilled.inserted > 0) {
    log.info(backfilled, "backfilled wake photo index");
  }
} catch (err) {
  // Non-fatal: the api can serve without a complete photo index; the next
  // boot retries.
  log.error({ err }, "wake photo backfill failed");
}

// CORS for the Vite dev server (web on :4200). In production the api serves the
// built web bundle from the same origin, so these are dev conveniences.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Routes a single request. Wrapped by fetch() below, which logs every call.
async function handle(req: Request, url: URL): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Generated route table (S3 seam). Iterated before the residual hand-wired
  // ladder; CORS is overlaid centrally here (mirrors the /trpc path below), so
  // route handlers return bare Responses.
  const route = findRoute(GENERATED_ROUTES, req.method, url.pathname);
  if (route) {
    const res = await route.handler(req, url);
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  }

  if (url.pathname === "/up") {
    return new Response("OK", { status: 200, headers: CORS_HEADERS });
  }

  // Deploy-health probe target (www-hya3) moved to features/ac/http.ts (S3 route seam).

  // Now-playing artwork proxy moved to features/tv/http.ts (Track C, Wave 6),
  // reached via the generated route table above.

  // Camera-stream proxy moved to features/dogcam/http.ts (S3 route seam).

  // Wake-photo ingest moved to apps/api/src/http/wake.http.ts (S3 route seam).

  // Wake-photo bytes for the viewer moved to features/wakes/http.ts (S3 route seam).

  // Photo-booth ingest moved to apps/api/src/http/booth.http.ts (S3 route seam).

  // Photo-booth bytes for the gallery moved to features/booth/http.ts (S3 route seam).

  if (url.pathname.startsWith("/trpc")) {
    const res = await fetchRequestHandler({
      endpoint: "/trpc",
      req,
      router: appRouter,
      createContext: () => createContext(),
      onError: ({ path, error, req: errorReq }) => {
        // Build the child logger inline, path is available here but reqId comes
        // from the outer fetch scope, so we log with path + code directly.
        const reqUrl = new URL(errorReq.url);
        const reqLog = log.child({ method: errorReq.method, path: reqUrl.pathname });
        reqLog.error({ err: error, trpcPath: path ?? "<unknown>" }, "trpc error");
      },
    });
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  }

  return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
}

const server = Bun.serve({
  port: config.PORT,
  async fetch(req) {
    const url = new URL(req.url);
    // Single chokepoint: every network request (OPTIONS, /up, /trpc, 404)
    // routes through handle(), so logging here captures all of them with
    // method, path, status, and wall-clock duration.
    const startedAt = performance.now();
    // Bind a per-request child logger with a unique request id so every log
    // line for this request carries the same correlation fields.
    const reqId = `req_${Math.random().toString(36).slice(2, 10)}`;
    const reqLog = log.child({ reqId, method: req.method, path: url.pathname });

    let res: Response;
    try {
      res = await handle(req, url);
    } catch (err) {
      const durationMs = +(performance.now() - startedAt).toFixed(1);
      reqLog.error({ err, status: 500, durationMs }, "request failed");
      throw err;
    }

    const durationMs = +(performance.now() - startedAt).toFixed(1);
    // A successful OPTIONS preflight is pure transport noise (always the same
    // 2xx) and would roughly double the info line count, so it is not logged at
    // all rather than demoted to debug , we do not emit below info
    // (docs/logging.md §3). A FAILING preflight is the interesting case (it
    // breaks every subsequent request), so that one is a warn.
    if (req.method === "OPTIONS") {
      if (res.status >= 400) {
        reqLog.warn({ status: res.status, durationMs }, "cors preflight rejected");
      }
    } else {
      reqLog.info({ status: res.status, durationMs }, "request completed");
    }
    return res;
  },
});

// Startup liveness line (docs/logging.md §6): "api started" with port + env
// is the operator's first grep after a deploy.
log.info({ port: server.port, env: config.NODE_ENV }, "api started");

// The api is request-only (www-7d5b.1.2). The device-sync and weather-ingest
// loops now run in the dedicated worker process (src/worker.ts), so the api no
// longer starts them in-process.
