import { describe, expect, it } from "vitest";
import { createApnsClient } from "./apns-client";

describe("APNs client", () => {
  it("classifies a device rejection without exposing its response body", async () => {
    const client = createApnsClient({
      authorization: async () => "bearer provider-jwt",
      transport: async () => ({
        status: 410,
        headers: { "apns-id": "apple-id" },
        body: JSON.stringify({ reason: "Unregistered", timestamp: 1_700_000_000 }),
      }),
      host: "https://api.push.apple.com",
      topic: "co.worldwidewebb.textyourex",
    });

    await expect(
      client.send({
        deviceToken: "ab".repeat(32),
        notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expiresAtMs: null,
      }),
    ).resolves.toEqual({ kind: "invalid_device", reason: "invalid_device" });
  });

  it("turns a network failure into a retryable result", async () => {
    const client = createApnsClient({
      authorization: async () => "bearer provider-jwt",
      transport: async () => {
        throw new Error("socket closed");
      },
      host: "https://api.push.apple.com",
      topic: "co.worldwidewebb.textyourex",
    });

    await expect(
      client.send({
        deviceToken: "ab".repeat(32),
        notificationId: "ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expiresAtMs: null,
      }),
    ).resolves.toEqual({ kind: "retry", reason: "network_error", retryAfterMs: 15_000 });
  });
});
