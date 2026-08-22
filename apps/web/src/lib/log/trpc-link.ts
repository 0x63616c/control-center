/**
 * A tRPC link that logs failed calls.
 *
 * This is the single highest-value source in the stack. `ConnectionLostBanner`
 * currently tells you the panel cannot reach the api and nothing else, because
 * `useConnectionStatus` infers "lost" from a sustained error state in the React
 * Query cache and never records the cause. With this link in place the log says
 * which procedure failed, how long it took, and what the server (or the network)
 * actually returned , which is the sentence you want at 3am, standing at a panel
 * with no devtools.
 *
 * Request inputs are recorded too. That is a deliberate, explicit choice by the
 * panel's owner: this is a private wall panel on a home network, the logs never
 * leave the device, and a failure you cannot see the input for is a failure you
 * end up guessing about. Note it does mean payloads (which can include Tesla
 * coordinates and camera URLs) persist in IndexedDB on the device, which is a
 * divergence from docs/logging.md §4 for the backend , made knowingly, and
 * scoped to a device only its owner can physically reach.
 */

import type { AppRouter } from "@cc/api/trpc";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { log } from "./logger";

const trpcLog = log.child("trpc");

/** Pull an HTTP status out of a tRPC client error, whatever flavour it is. */
function httpStatusOf(err: unknown): number | undefined {
  if (!(err instanceof TRPCClientError)) return undefined;
  const data = err.data as { httpStatus?: number } | undefined;
  if (typeof data?.httpStatus === "number") return data.httpStatus;
  const meta = err.meta as { response?: { status?: number } } | undefined;
  return meta?.response?.status;
}

function errorShape(err: unknown): Record<string, unknown> {
  if (err instanceof TRPCClientError) {
    const data = err.data as { code?: string } | undefined;
    return {
      code: data?.code,
      httpStatus: httpStatusOf(err),
      message: err.message,
    };
  }
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}

export const loggingLink: TRPCLink<AppRouter> = () => {
  return ({ op, next }) =>
    observable((observer) => {
      const started = performance.now();
      const base = { type: op.type, path: op.path } as const;

      const subscription = next(op).subscribe({
        next(value) {
          observer.next(value);
        },
        error(err) {
          trpcLog.error(`${op.path} failed`, {
            ...base,
            ms: Math.round(performance.now() - started),
            ...errorShape(err),
            input: op.input,
          });
          observer.error(err);
        },
        complete: () => observer.complete(),
      });

      return () => subscription.unsubscribe();
    });
};
