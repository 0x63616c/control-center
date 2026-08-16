export type ApnsOutcome =
  | { readonly kind: "accepted"; readonly apnsId: string | null }
  | { readonly kind: "invalid_device"; readonly reason: string }
  | { readonly kind: "retry"; readonly reason: string; readonly retryAfterMs: number }
  | { readonly kind: "permanent_notification"; readonly reason: string }
  | { readonly kind: "provider_configuration"; readonly reason: string };

export interface ApnsResponseSummary {
  readonly status: number;
  readonly reason: string | null;
  readonly apnsId: string | null;
  readonly retryAfterMs?: number;
}

const INVALID_DEVICE_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);
const PROVIDER_CONFIGURATION_REASONS = new Set([
  "Forbidden",
  "InvalidProviderToken",
  "MissingProviderToken",
  "ExpiredProviderToken",
]);

export function classifyApnsResponse(response: ApnsResponseSummary): ApnsOutcome {
  if (response.status >= 200 && response.status < 300) {
    return { kind: "accepted", apnsId: response.apnsId };
  }
  const reason = response.reason ?? `HTTP_${response.status}`;
  if (INVALID_DEVICE_REASONS.has(reason) || response.status === 410) {
    return { kind: "invalid_device", reason: "invalid_device" };
  }
  if (reason === "TooManyRequests" || response.status === 429) {
    return { kind: "retry", reason: "throttled", retryAfterMs: response.retryAfterMs ?? 60_000 };
  }
  if (response.status >= 500) {
    return {
      kind: "retry",
      reason: "provider_unavailable",
      retryAfterMs: Math.max(response.retryAfterMs ?? 0, 900_000),
    };
  }
  if (PROVIDER_CONFIGURATION_REASONS.has(reason) || response.status === 403) {
    return { kind: "provider_configuration", reason: "provider_configuration" };
  }
  return { kind: "permanent_notification", reason: "bad_notification" };
}
