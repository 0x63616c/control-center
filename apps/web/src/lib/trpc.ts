import type { AppRouter } from "@cc/api/trpc";
import { QueryClient } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { type CreateTRPCReact, createTRPCReact } from "@trpc/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { loggingFetch } from "./log/fetch-log";
import { loggingLink } from "./log/trpc-link";

export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export type RouterOutputs = inferRouterOutputs<AppRouter>;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Bounded retries with exponential backoff (1s, 2s, 4s, 8s, 16s, capped at
      // 30s). An unbounded 5s retry turns any upstream blip into a self-inflicted
      // request storm; this rides out transient failures without hammering.
      retry: 5,
      retryDelay: (attempt) => Math.min(30_000, 1_000 * 2 ** attempt),
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// Vite proxies /trpc -> the api (API_PORT, default 4201). Same-origin in prod.
// loggingLink is first in the chain so it observes the whole call, including the
// time httpBatchLink spends batching and retrying.
// loggingFetch sits UNDER tRPC and records the HTTP truth (status, content-type,
// and the body of anything that isn't a clean JSON 200). tRPC's own error only
// carries an httpStatus when the server replied with a proper tRPC envelope, so
// without this a 502 HTML page or an Access challenge surfaces as nothing more
// than "Failed to execute 'json' on 'Response'".
export const trpcClient = trpc.createClient({
  links: [loggingLink, httpBatchLink({ url: "/trpc", fetch: loggingFetch })],
});
