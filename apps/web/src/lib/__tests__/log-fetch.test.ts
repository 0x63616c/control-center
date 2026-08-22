/**
 * The HTTP layer of the logger.
 *
 * These pin the cases that the tRPC link alone is BLIND to, and which were the
 * reason the panel could say "Unable to connect" while the log offered nothing
 * but `Failed to execute 'json' on 'Response'`. tRPC only carries an httpStatus
 * when the server replied with a well-formed tRPC envelope; a 502 HTML page, a
 * Cloudflare Access challenge, or no response at all never gets that far.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loggingFetch } from "../log/fetch-log";
import { getTail } from "../log/logger";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function httpEntriesSince(n: number) {
  return getTail()
    .slice(n)
    .filter((e) => e.source === "http");
}

describe("loggingFetch", () => {
  it("records status, content-type and the BODY of a non-JSON error response", async () => {
    // The exact shape that defeated the old logging: an HTML error page. tRPC
    // dies parsing it and reports a JSON error; the status and the page's own
    // explanation - which is the useful part - were thrown away.
    const before = getTail().length;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        "<html><body><h1>502 Bad Gateway</h1><p>upstream connect error</p></body></html>",
        {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "content-type": "text/html" },
        },
      ),
    );

    await loggingFetch("/trpc/tesla.get");

    const [entry] = httpEntriesSince(before);
    expect(entry.level).toBe("error");
    const data = entry.data as Record<string, unknown>;
    expect(data.status).toBe(502);
    expect(data.statusText).toBe("Bad Gateway");
    expect(data.contentType).toContain("text/html");
    expect(String(data.body)).toContain("upstream connect error");
  });

  it("flags a 200 that is not JSON , a login page served where data belongs", async () => {
    // A Cloudflare Access challenge or a misrouted ingress returning index.html
    // comes back 200 OK. Status alone would call this healthy.
    const before = getTail().length;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("<html>Sign in to continue</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    await loggingFetch("/trpc/tesla.get");

    const [entry] = httpEntriesSince(before);
    expect(entry.level).toBe("error");
    const data = entry.data as Record<string, unknown>;
    expect(data.status).toBe(200);
    expect(String(data.body)).toContain("Sign in");
  });

  it("records a request that gets NO response at all", async () => {
    // Offline, DNS failure, connection refused, TLS error. This is what the iPad
    // hits when it genuinely cannot reach the api, and it previously surfaced
    // only as tRPC's unhelpful JSON-parse message.
    const before = getTail().length;
    const boom = new TypeError("Load failed");
    globalThis.fetch = vi.fn().mockRejectedValue(boom);

    await expect(loggingFetch("/trpc/tesla.get")).rejects.toThrow("Load failed");

    const [entry] = httpEntriesSince(before);
    expect(entry.level).toBe("error");
    expect(entry.msg).toContain("no response");
    const data = entry.data as { error: { name: string; message: string }; online: boolean };
    expect(data.error.message).toBe("Load failed");
    expect(typeof data.online).toBe("boolean"); // navigator.onLine, to separate
    // "the wifi dropped" from "the api is broken"
  });

  it("keeps the happy path quiet, and does not consume the body", async () => {
    const before = getTail().length;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { data: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await loggingFetch("/trpc/tesla.get");

    expect(httpEntriesSince(before)).toEqual([]);
    // Critical: the caller still needs to parse the real response.
    await expect(res.json()).resolves.toEqual({ result: { data: 1 } });
  });
});
