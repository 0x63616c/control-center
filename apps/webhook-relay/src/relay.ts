import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "@www/logger";
import {
  observeWebhookRelayDelivery,
  observeWebhookRelayForward,
  observeWebhookRelayGiveUp,
  observeWebhookRelayRejected,
} from "@www/platform/metrics";
import type { RelayTarget } from "./config";

const FORWARDED_HEADERS = [
  "x-hub-signature-256",
  "x-github-delivery",
  "x-github-event",
  "x-github-hook-id",
  "content-type",
] as const;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type RelayOptions = Readonly<{
  secret: string;
  targets: readonly RelayTarget[];
  fetch?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: Pick<Logger, "warn" | "error">;
  timeoutMs?: number;
}>;

function validSignature(raw: Uint8Array, header: string | null, secret: string): boolean {
  if (!header || raw.byteLength > MAX_BODY_BYTES) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const provided = Buffer.from(header);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function forwardedHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) result.set(name, value);
  }
  return result;
}
export function createRelay(options: RelayOptions): (request: Request) => Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const forward = async (
    target: RelayTarget,
    body: Uint8Array,
    headers: Headers,
    deliveryId: string | null,
    event: string | null,
  ): Promise<void> => {
    let outcome = "network_error";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const exactBody = new ArrayBuffer(body.byteLength);
        new Uint8Array(exactBody).set(body);
        const response = await fetchImpl(target.url, {
          method: "POST",
          headers,
          body: exactBody,
          signal: controller.signal,
        });
        outcome = response.status >= 500 ? "5xx" : response.status >= 400 ? "4xx" : "success";
        observeWebhookRelayForward(target.name, outcome, (performance.now() - started) / 1000);
        if (response.status < 400) return;
        if (response.status < 500) return;
      } catch (error) {
        outcome =
          error instanceof DOMException && error.name === "AbortError"
            ? "timeout"
            : "network_error";
        observeWebhookRelayForward(target.name, outcome, (performance.now() - started) / 1000);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < 3) await sleep(attempt * 100);
    }
    observeWebhookRelayGiveUp(target.name);
    options.logger?.error(
      { target: target.name, deliveryId, event, outcome },
      "webhook relay forward dropped",
    );
  };
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health")
      return request.method === "GET" ? new Response("OK") : new Response(null, { status: 405 });
    // GitHub's configured URL predates the relay and uses /hooks/github. Keep
    // that public contract while also allowing the relay-native /github path.
    if (pathname !== "/github" && pathname !== "/hooks/github")
      return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = new Uint8Array(await request.arrayBuffer());
    if (!validSignature(body, request.headers.get("x-hub-signature-256"), options.secret)) {
      observeWebhookRelayRejected();
      options.logger?.warn(
        { deliveryId: request.headers.get("x-github-delivery") },
        "webhook relay rejected",
      );
      return new Response(null, { status: 401 });
    }
    observeWebhookRelayDelivery();
    const headers = forwardedHeaders(request.headers);
    const deliveryId = request.headers.get("x-github-delivery");
    const event = request.headers.get("x-github-event");
    for (const target of options.targets)
      void forward(target, body, headers, deliveryId, event).catch(() => undefined);
    return new Response(null, { status: 204 });
  };
}
