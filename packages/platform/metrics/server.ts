/**
 * A minimal, dedicated listener that serves nothing but the exposition text.
 *
 * Dedicated PORT, not a route on an existing server, and this is a security
 * boundary rather than a style choice: the api's :4201 is mapped through the
 * Cloudflare tunnel (the public, non-Access-gated `hooks.` host resolves to it),
 * so a `/metrics` route there would put the process's full internal state on
 * the public internet. Nothing creates a Kubernetes Service for this port —
 * Prometheus scrapes the pod IP directly off the pod annotations
 * (`WorkloadSpec.scrape`), so the port is reachable in-cluster only.
 *
 * `node:http` rather than `Bun.serve` because this same code runs on bun (api,
 * worker) AND on node (temporal-worker, whose runtime is forced by the Temporal
 * SDK's native bridge).
 */
import { createServer, type Server } from "node:http";
import type { Logger } from "@www/logger";
import { METRICS_PATH } from "./port";
import { metricsHandler } from "./registry";

export type MetricsServerOptions = {
  port: number;
  /**
   * Bind address. Defaults to every interface: the scrape arrives from the
   * Prometheus pod over the cluster network, so a loopback bind would make the
   * endpoint unreachable.
   */
  host?: string;
  /** Path the exposition is served on. Must match `WorkloadSpec.scrape.path`. */
  path?: string;
  logger?: Logger;
};

export type MetricsServer = {
  /**
   * The port actually bound, or `undefined` before the listen completes. Only
   * interesting when `port: 0` was passed (tests) — in prod the number is the
   * one that was asked for.
   */
  boundPort(): number | undefined;
  close(): void;
};

/**
 * Start the metrics listener. Never throws into the caller's boot path: a
 * failure to bind is logged and swallowed, because losing observability must
 * not take down the service being observed.
 */
export function startMetricsServer(opts: MetricsServerOptions): MetricsServer {
  const path = opts.path ?? METRICS_PATH;
  const server: Server = createServer((req, res) => {
    if (req.url?.split("?")[0] !== path) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
      return;
    }
    void metricsHandler()
      .then(async (response) => {
        const body = await response.text();
        res
          .writeHead(response.status, {
            "content-type": response.headers.get("content-type") ?? "text/plain",
          })
          .end(body);
      })
      .catch((err: unknown) => {
        opts.logger?.error({ err }, "metrics collection failed");
        res.writeHead(500, { "content-type": "text/plain" }).end("metrics collection failed");
      });
  });

  server.on("error", (err) => {
    opts.logger?.error({ err, port: opts.port }, "metrics listener failed");
  });

  // Unref'd so an idle metrics listener can never be the reason a process
  // refuses to exit after its real work is done.
  server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
    opts.logger?.info({ port: opts.port, path }, "metrics listener started");
  });
  server.unref();

  return {
    boundPort() {
      const address = server.address();
      return address && typeof address === "object" ? address.port : undefined;
    },
    close() {
      server.close();
    },
  };
}
