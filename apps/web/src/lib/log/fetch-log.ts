/**
 * A logging `fetch` for the tRPC client , the HTTP truth, underneath tRPC.
 *
 * Why this exists on top of trpc-link.ts: the tRPC link can only report what tRPC
 * hands it, and tRPC's error only carries an `httpStatus` when the server replied
 * with a well-formed tRPC error envelope. When the failure happens BELOW tRPC ,
 * an empty body, a Cloudflare Access challenge page, a 502 from the ingress, a
 * gateway timeout, the panel being offline , tRPC dies parsing the response and
 * the log reads:
 *
 *     tesla.get failed {"message":"Failed to execute 'json' on 'Response'…"}
 *
 * which tells you nothing about what actually came back. That is the exact case
 * you are standing at the panel trying to diagnose, and it is the case where the
 * old logging was blind.
 *
 * So this records the transport-level facts for failures: status, statusText,
 * content-type, duration, and a snippet of the actual body. A Cloudflare error
 * page or an nginx 502 says what is wrong in its body; there is no reason to
 * make you guess. Successful polling stays silent: recording every success
 * caused millions of redundant on-device writes without adding incident value.
 */

import { log } from "./logger";

const httpLog = log.child("http");

/** How much of a failed response body to keep. Enough to see the error page's point. */
const BODY_SNIPPET_CHARS = 600;

function requestOf(input: RequestInfo | URL): { url: string; method: string } {
  if (typeof input === "string") return { url: input, method: "GET" };
  if (input instanceof URL) return { url: input.href, method: "GET" };
  return { url: input.url, method: input.method };
}

/**
 * Read a bounded snippet of the body WITHOUT consuming it , the caller still
 * needs to parse the real response. Best-effort: a body that cannot be read (an
 * already-locked or opaque stream) must never turn a logging concern into a
 * request failure.
 */
async function snippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.clone().text();
    if (!text) return "<empty body>";
    return text.length > BODY_SNIPPET_CHARS ? `${text.slice(0, BODY_SNIPPET_CHARS)}…` : text;
  } catch {
    return undefined;
  }
}

/**
 * Drop-in `fetch` for the tRPC client. On anything that is not a clean JSON 200,
 * logs the HTTP outcome and the body that came back instead.
 */
export const loggingFetch: typeof fetch = async (input, init) => {
  const { url, method } = requestOf(input);
  const started = performance.now();

  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    // No response at all: DNS, TLS, connection refused, offline, CORS. This is
    // the branch that fires when the iPad genuinely cannot reach the api, and it
    // previously surfaced only as tRPC's unhelpful JSON-parse message.
    httpLog.error(`${method} ${url} , no response`, {
      method,
      url,
      ms: Math.round(performance.now() - started),
      online: navigator.onLine,
      error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
    });
    throw err;
  }

  const ms = Math.round(performance.now() - started);
  const contentType = res.headers.get("content-type") ?? undefined;
  const isJson = contentType?.includes("application/json") ?? false;

  if (res.ok && isJson) {
    return res;
  }

  // Anything else is the interesting case: a non-2xx, or a 200 that is not JSON
  // (an Access login page, an SPA index.html served by a misrouted ingress).
  httpLog.error(`${method} ${res.status} ${url}`, {
    method,
    url,
    status: res.status,
    statusText: res.statusText,
    contentType,
    ms,
    online: navigator.onLine,
    body: await snippet(res),
  });
  return res;
};
