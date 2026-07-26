import { captivePortalWeb, homelabTarget, privateWeb } from "@www/platform";
import { describe, expect, test } from "vitest";
import { accessAppsForPrivateWeb, desiredAccessApps } from "../src/access.ts";

// M3 moves private exposure toward a default-deny Cloudflare Access contract.

const ZONE = "worldwidewebb.co";

describe("desiredAccessApps", () => {
  test("DEFAULT (gate off): the product app route, but NO wildcard floor or hooks lock", () => {
    // www-b6ad: the not-yet-live gate additions (the *.<zone> default-deny floor
    // and the hooks CI lock) are off by default, so the floor can never block a
    // currently-public host (live dashboard) before it has an explicit bypass.
    const domains = desiredAccessApps(ZONE)
      .map((a) => a.domain)
      .sort();
    expect(domains).toEqual(["app.worldwidewebb.co", "temporal-ui.worldwidewebb.co"]);
    expect(domains).not.toContain("*.worldwidewebb.co");
    expect(domains).not.toContain("hooks.worldwidewebb.co");
    expect(domains).not.toContain("drizzle.worldwidewebb.co");
    // Task 7 Step C: the flattened app--cc cutover app is retired.
    expect(domains).not.toContain("app--cc.worldwidewebb.co");
  });

  test("declares the wildcard block floor, app kiosk, and hooks CI apps", () => {
    const domains = desiredAccessApps(ZONE, true)
      .map((a) => a.domain)
      .sort();
    expect(domains).toEqual([
      "*.worldwidewebb.co",
      "app.worldwidewebb.co",
      "hooks.worldwidewebb.co",
      "temporal-ui.worldwidewebb.co",
    ]);
    expect(domains).not.toContain("app--cc.worldwidewebb.co");
    expect(domains).not.toContain("drizzle.worldwidewebb.co");
  });

  test("temporal-ui is human-login only — NEVER reachable with the kiosk token", () => {
    // The Temporal UI can terminate and reset running workflows. The wall panel
    // authenticates with a service token it stores on-device and never prompts
    // for; that token must not open this door.
    const ui = desiredAccessApps(ZONE, true).find(
      (entry) => entry.domain === "temporal-ui.worldwidewebb.co",
    );

    expect(ui?.policies).toEqual([
      {
        decision: "allow",
        include: { configKey: "allowedEmail", kind: "email-config" },
        name: "email-otp",
        precedence: 1,
      },
    ]);
  });

  test("supports kiosk service-token access for app (+ email-OTP fallback for browser, CC-d15)", () => {
    const app = desiredAccessApps(ZONE, true).find(
      (entry) => entry.domain === "app.worldwidewebb.co",
    );

    expect(app?.policies).toEqual([
      {
        // Service Auth: an "allow" policy is identity-based and redirects a
        // valid service token to login (auth_status:NONE); non_identity grants it.
        decision: "non_identity",
        include: { configKey: "kioskTokenId", kind: "service-token-config" },
        name: "kiosk-service-token",
        precedence: 1,
      },
      {
        decision: "allow",
        include: { configKey: "allowedEmail", kind: "email-config" },
        name: "email-otp",
        precedence: 2,
      },
    ]);
  });

  test("models the default-deny wildcard floor as an explicit deny policy", () => {
    const floor = desiredAccessApps(ZONE, true).find((app) => app.domain === "*.worldwidewebb.co");

    expect(floor?.policies).toEqual([
      {
        decision: "deny",
        include: { kind: "everyone" },
        name: "default-deny",
        precedence: 99,
      },
    ]);
  });

  test("keeps hooks on CI service-token access, not human-only SSO", () => {
    const hooks = desiredAccessApps(ZONE, true).find(
      (app) => app.domain === "hooks.worldwidewebb.co",
    );

    expect(hooks?.policies).toEqual([
      {
        decision: "non_identity",
        include: { configKey: "ciClientId", kind: "service-token-config" },
        name: "ci-service-token",
        precedence: 1,
      },
    ]);
  });

  test("emits no literal personal email anywhere in the access apps", () => {
    expect(JSON.stringify(desiredAccessApps(ZONE, true))).not.toMatch(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+/i,
    );
  });

  test("derives privateWeb apps without gating non-private exposures", () => {
    expect(
      accessAppsForPrivateWeb([
        {
          exposure: privateWeb(homelabTarget, { host: "app" }),
          policies: ["email-otp"],
        },
        {
          // captive-portal-web is LAN-only, never a Cloudflare Access app.
          exposure: captivePortalWeb(homelabTarget, { host: "app" }),
          policies: ["email-otp"],
        },
      ]).map((app) => app.domain),
    ).toEqual(["app.worldwidewebb.co"]);
  });

  test("every app carries the live ownership tag so the import is zero-diff", () => {
    for (const app of desiredAccessApps(ZONE, true)) {
      expect(app.tag).toBe("bosun:control-center");
    }
  });
});
