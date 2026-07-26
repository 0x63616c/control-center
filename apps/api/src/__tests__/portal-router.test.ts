/**
 * Router-wiring test for the portal router (www-q002.9, password-only since
 * www-p9hx). The full behavioural matrix (checkPassword, global rate limit,
 * authorize, status) lives in features/guest-wifi/service.test.ts. The PortalError→tRPC code
 * map is exhaustive by construction (a `Record<PortalErrorCode, TRPCError["code"]>`
 * , the compiler rejects an unmapped state). Here we only assert the router is
 * registered with every procedure the frontend calls.
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "../trpc/routers/index";

describe("portal router wiring", () => {
  it("registers the password-only procedures on the appRouter", () => {
    const names = Object.keys(appRouter._def.procedures).filter((k) => k.startsWith("portal."));
    expect(names).toEqual(
      expect.arrayContaining(["portal.checkPassword", "portal.authorize", "portal.status"]),
    );
  });

  it("no longer exposes the removed email/OTP procedures", () => {
    const names = Object.keys(appRouter._def.procedures);
    expect(names).not.toContain("portal.sendCode");
    expect(names).not.toContain("portal.verifyCode");
    expect(names).not.toContain("portal.resetAttempts");
  });
});
