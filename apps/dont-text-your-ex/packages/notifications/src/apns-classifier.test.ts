import { describe, expect, test } from "vitest";
import { classifyApnsResponse } from "./apns-classifier";

describe("classifyApnsResponse", () => {
  test("accepts success and retains Apple's request id", () => {
    expect(classifyApnsResponse({ status: 200, reason: null, apnsId: "apple-id" })).toEqual({
      kind: "accepted",
      apnsId: "apple-id",
    });
  });

  test.each([
    "BadDeviceToken",
    "DeviceTokenNotForTopic",
    "Unregistered",
  ])("deactivates token-specific response %s", (reason) => {
    expect(classifyApnsResponse({ status: 400, reason, apnsId: null }).kind).toBe("invalid_device");
  });

  test("retries throttling and server failures", () => {
    expect(classifyApnsResponse({ status: 429, reason: "TooManyRequests", apnsId: null })).toEqual({
      kind: "retry",
      reason: "throttled",
      retryAfterMs: 60_000,
    });
    expect(classifyApnsResponse({ status: 503, reason: "Shutdown", apnsId: null })).toEqual({
      kind: "retry",
      reason: "provider_unavailable",
      retryAfterMs: 900_000,
    });
  });

  test("separates provider configuration from bad notification data", () => {
    expect(
      classifyApnsResponse({ status: 403, reason: "InvalidProviderToken", apnsId: null }).kind,
    ).toBe("provider_configuration");
    expect(
      classifyApnsResponse({ status: 400, reason: "PayloadTooLarge", apnsId: null }).kind,
    ).toBe("permanent_notification");
  });
});
