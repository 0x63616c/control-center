import { describe, expect, it, vi } from "vitest";
import { createCachedApnsAuthorization } from "./apns-jwt";

describe("APNs provider authorization", () => {
  it("reuses a provider token for less than twenty minutes", async () => {
    let now = 1_750_000_000_000;
    const sign = vi.fn(async () => `jwt-${now}`);
    const authorization = createCachedApnsAuthorization(
      { keyId: "KEY", teamId: "TEAM", keyContent: "p8" },
      sign,
      () => now,
    );

    expect(await authorization()).toBe(`bearer jwt-${now}`);
    now += 19 * 60_000;
    expect(await authorization()).toBe("bearer jwt-1750000000000");
    now += 2 * 60_000;
    expect(await authorization()).toBe(`bearer jwt-${now}`);
    expect(sign).toHaveBeenCalledTimes(2);
  });
});
