import { type ApnsOutcome, classifyApnsResponse } from "./apns-classifier";
import { type ApnsHttpRequest, buildApnsRequest } from "./apns-request";

export interface ApnsHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export type ApnsHttpTransport = (request: ApnsHttpRequest) => Promise<ApnsHttpResponse>;

export interface ApnsClient {
  send(input: {
    readonly deviceToken: string;
    readonly notificationId: string;
  }): Promise<ApnsOutcome>;
}

function responseReason(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "reason" in parsed &&
      typeof parsed.reason === "string"
    ) {
      return parsed.reason;
    }
  } catch {
    // An unparseable APNs response is classified by its status, never logged here.
  }
  return null;
}

function retryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

export function createApnsClient(deps: {
  readonly authorization: () => Promise<string>;
  readonly transport: ApnsHttpTransport;
  readonly host: string;
  readonly topic: string;
}): ApnsClient {
  return {
    async send(input) {
      try {
        const response = await deps.transport(
          buildApnsRequest({
            host: deps.host,
            topic: deps.topic,
            authorization: await deps.authorization(),
            ...input,
          }),
        );
        return classifyApnsResponse({
          status: response.status,
          reason: responseReason(response.body),
          apnsId: response.headers["apns-id"] ?? null,
          retryAfterMs: retryAfterMs(response.headers["retry-after"]),
        });
      } catch {
        return { kind: "retry", reason: "network_error", retryAfterMs: 15_000 };
      }
    },
  };
}
