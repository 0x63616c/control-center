import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createLogger, type Logger } from "@www/logger";
import { createContext } from "./trpc/context";
import { guestRouter } from "./trpc/guest-router";

// Structural security boundary (ADR-0006): this is the ONLY listener
// unauthenticated LAN guests (the WiFi captive-portal network) ever reach. It
// mounts exactly `guestRouter` (portal.* only, see trpc/guest-router.ts), never
// the full `appRouter`, so no other tRPC procedure is ever reachable through
// GUEST_PORT no matter what path or batch shape a client sends.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Minimal extension -> content-type map for the guest SPA bundle (Vite output:
// html/js/css/json/images/fonts). Anything unrecognised falls back to
// octet-stream , this is a static asset server, not a general file host.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface StartGuestServerOptions {
  /** TLS port. A plain-HTTP companion is also started on `httpPort` (default: port + 1). */
  port: number;
  /** Directory holding fullchain.pem + key.pem (cert-manager projection). Omit for plain HTTP only. */
  tlsDir?: string;
  /** Built guest web bundle (SPA) to serve static files from. */
  staticDir: string;
  /**
   * The always-plain-HTTP companion port. Defaults to `port + 1` (dev/test,
   * and the dark cluster-only deploy where the exact number doesn't matter).
   * The real LAN cutover needs this set explicitly to 80 alongside `port: 443`
   * , the k8s Service's exposed port always equals the container port (no
   * remap), so "port + 1" can't land on the conventional plain-HTTP port.
   */
  httpPort?: number;
  logger?: Logger;
}

export interface GuestServer {
  /** The TLS (or, if tlsDir is unset, plain) listener port. */
  port: number;
  /** The always-plain-HTTP companion listener port (port + 1), for captive-portal OS detection probes. */
  httpPort: number;
  stop(): void;
}

// Resolves a URL pathname to a file under staticDir, refusing to escape it
// (guest-facing, so directory traversal is a required-blocked case, not just a
// nicety). Returns null if the decoded/resolved path would land outside
// staticDir.
function resolveStaticPath(staticDir: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const root = resolve(staticDir);
  const candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return null;
  }
  return candidate;
}

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function serveStatic(staticDir: string, pathname: string): Promise<Response> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolveStaticPath(staticDir, requested);
  if (filePath === null) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }

  let body = await readIfExists(filePath);
  let servedPath = filePath;
  if (body === null) {
    // SPA fallback: any unmatched path (a client-side route, or a traversal
    // attempt that resolved to nothing) serves index.html, never a directory
    // listing or a bubbled-up filesystem error.
    const fallback = resolveStaticPath(staticDir, "/index.html");
    if (fallback === null) {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }
    body = await readIfExists(fallback);
    servedPath = fallback;
    if (body === null) {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }
  }

  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": contentTypeFor(servedPath) },
  });
}

/**
 * Builds the guest routing logic as a pure `Request -> Response` function:
 * `/up`, `/trpc/portal.*` (portal-only, via guestRouter), and static files
 * from `staticDir` with SPA fallback + traversal guard. Deliberately has no
 * dependency on any particular listener (Bun.serve, node:http, tests) , this
 * is what `startGuestServer` binds to a real port, and what unit tests call
 * directly with a constructed `Request` to verify routing/security behaviour
 * without needing a real socket.
 */
export function createGuestFetchHandler(opts: {
  staticDir: string;
  logger: Logger;
}): (req: Request) => Promise<Response> {
  const { staticDir, logger: log } = opts;

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/up") {
      return new Response("OK", { status: 200, headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith("/trpc")) {
      const res = await fetchRequestHandler({
        endpoint: "/trpc",
        req,
        router: guestRouter,
        createContext: () => createContext(),
        onError: ({ path, error, req: errorReq }) => {
          const reqUrl = new URL(errorReq.url);
          log
            .child({ method: errorReq.method, path: reqUrl.pathname })
            .error({ err: error, trpcPath: path ?? "<unknown>" }, "guest trpc error");
        },
      });
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
      return redactGuestTrpcResponse(res);
    }

    return serveStatic(staticDir, url.pathname);
  };
}

// tRPC's default errorFormatter passes `error.message` (and, for unhandled
// exceptions, `error.data.stack`) through verbatim onto the wire. That's fine
// for the authenticated `appRouter` surface, but the guest listener is reached
// by unauthenticated LAN devices (ADR-0006), so a raw DB/internal error (e.g.
// a Postgres query failure) must never leak column names, file paths, or
// stack frames to a guest. Typed `PortalError` flows (wrong password, rate
// limited, not configured) map onto non-5xx tRPC codes (see
// features/guest-wifi/api.ts's `ERROR_CODE_MAP`) and carry guest-safe copy that
// must reach the client unchanged; only the >=500 "something broke"
// path gets redacted here.
function redactErrorItem(item: unknown): unknown {
  if (typeof item !== "object" || item === null) {
    return item;
  }
  const obj = item as Record<string, unknown>;
  const error = obj.error;
  if (typeof error !== "object" || error === null) {
    return item;
  }
  const errObj = error as Record<string, unknown>;
  const data = errObj.data;
  const httpStatus =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>).httpStatus
      : undefined;
  if (typeof httpStatus !== "number" || httpStatus < 500) {
    return item;
  }
  const { stack: _stack, ...restData } =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  return {
    ...obj,
    error: {
      ...errObj,
      message: "Internal error",
      data: restData,
    },
  };
}

/**
 * Redacts internal error detail (message + stack) from a parsed tRPC
 * response body, for any item whose `error.data.httpStatus >= 500`. Handles
 * both a single-call body (`{ error: {...} }`) and a batched body (an array
 * of such objects), and leaves non-5xx items (BAD_REQUEST, NOT_FOUND,
 * TOO_MANY_REQUESTS, ...) completely untouched. Pure so it's directly
 * unit-testable against a realistic tRPC error envelope without needing a
 * real procedure to throw.
 */
export function redactGuestErrorBody(json: unknown): unknown {
  if (Array.isArray(json)) {
    return json.map(redactErrorItem);
  }
  return redactErrorItem(json);
}

async function redactGuestTrpcResponse(res: Response): Promise<Response> {
  // Gate on the response body's own error shape, not the aggregate HTTP
  // status: a batched call mixing a 500-level procedure with others comes
  // back as 207 Multi-Status (see guest-server.test.ts), so a plain
  // `res.status >= 500` gate would let a batched internal error straight
  // through un-redacted. `res.status < 200` is an informational response
  // class that never carries a JSON body (this handler never actually emits
  // one below 200, but the guard is defensive); anything >= 200 gets
  // inspected per-item by `redactGuestErrorBody`, which is a no-op for items
  // that aren't a >=500 tRPC error (including a bodiless 204 OPTIONS
  // response, since `res.clone().json()` on an empty body throws and falls
  // into the catch-and-pass-through branch just below).
  if (res.status < 200) {
    return res;
  }
  let json: unknown;
  try {
    json = await res.clone().json();
  } catch {
    // Not a JSON body (shouldn't happen for the tRPC fetch adapter) , pass
    // through rather than risk masking a real response.
    return res;
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(redactGuestErrorBody(json)), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function withRequestLogging(
  handle: (req: Request) => Promise<Response>,
  log: Logger,
  listener: string,
): (req: Request) => Promise<Response> {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const startedAt = performance.now();
    const reqId = `req_${Math.random().toString(36).slice(2, 10)}`;
    const reqLog = log.child({ reqId, method: req.method, path: url.pathname, listener });

    let res: Response;
    try {
      res = await handle(req);
    } catch (err) {
      const durationMs = +(performance.now() - startedAt).toFixed(1);
      reqLog.error({ err, status: 500, durationMs }, "guest request failed");
      throw err;
    }

    const durationMs = +(performance.now() - startedAt).toFixed(1);
    // Successful preflights are not logged (see server.ts): we never emit below
    // info, and a 2xx OPTIONS carries no signal. A rejected one does.
    if (req.method === "OPTIONS") {
      if (res.status >= 400) {
        reqLog.warn({ status: res.status, durationMs }, "guest cors preflight rejected");
      }
    } else {
      reqLog.info({ status: res.status, durationMs }, "guest request completed");
    }
    return res;
  };
}

/**
 * Starts the guest (captive-portal) HTTP surface via `Bun.serve`: `/up`,
 * `/trpc/portal.*`, and static files from `staticDir` with SPA fallback (see
 * `createGuestFetchHandler`). TLS on `port` when `tlsDir` is set (reading
 * fullchain.pem + key.pem, the cert-manager secret projection the old nginx
 * portal used); ALWAYS also starts a plain-HTTP companion on `port + 1` for
 * captive-portal OS detection probes, which must not hit a TLS handshake or
 * cert prompt to decide whether the network is "captive".
 *
 * Runs only under the Bun runtime (production/dev, via `bun src/server.ts`).
 * Routing/security behaviour is unit-tested via `createGuestFetchHandler`
 * directly, which needs no real socket and no Bun-specific API.
 */
export function startGuestServer(opts: StartGuestServerOptions): GuestServer {
  const log = opts.logger ?? createLogger({ service: "guest-api" });
  const handle = createGuestFetchHandler({ staticDir: opts.staticDir, logger: log });
  const fetch = withRequestLogging(handle, log, "guest");
  const httpFetch = withRequestLogging(handle, log, "guest-http");

  const tls = opts.tlsDir
    ? {
        cert: Bun.file(`${opts.tlsDir}/fullchain.pem`),
        key: Bun.file(`${opts.tlsDir}/key.pem`),
      }
    : undefined;

  const mainServer = Bun.serve({
    port: opts.port,
    ...(tls ? { tls } : {}),
    fetch,
  });

  // Bind relative to the *actual* bound main-server port, not the requested
  // one: with a fixed port (real deployments) these are the same, but with
  // `port: 0` (ephemeral, e.g. tests) `opts.port` stays 0 while
  // `mainServer.port` is the OS-assigned port , binding off `opts.port + 1`
  // there would land on port 1, not "next to the main listener". An explicit
  // `httpPort` (the real 443/80 LAN cutover) always wins over this offset.
  const httpServer = Bun.serve({
    port: opts.httpPort ?? (mainServer.port ?? opts.port) + 1,
    fetch: httpFetch,
  });

  log.info(
    { port: mainServer.port, httpPort: httpServer.port, tls: Boolean(tls) },
    "guest api started",
  );

  return {
    port: mainServer.port ?? opts.port,
    httpPort: httpServer.port ?? opts.port + 1,
    stop() {
      mainServer.stop(true);
      httpServer.stop(true);
    },
  };
}
