import { captivePortalWeb, homelabTarget, privateWeb, publicWeb } from "@www/platform";
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

  test("declares the wildcard block floor, app kiosk, and the hooks bypass", () => {
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

  // #126: hooks. is a PUBLIC receiver. The wildcard default-deny floor would
  // sweep it up the moment the gate is switched on and silently break GitHub
  // deliveries, so the bypass must exist and must be `everyone`. A service-token
  // policy here (what this host used to carry) would reject every delivery.
  test("hooks. carries an everyone bypass so the deny floor cannot break deliveries", () => {
    const hooks = desiredAccessApps(ZONE, true).find(
      (entry) => entry.domain === "hooks.worldwidewebb.co",
    );

    expect(hooks?.policies).toHaveLength(1);
    expect(hooks?.policies[0]).toMatchObject({ decision: "allow", include: { kind: "everyone" } });
    expect(hooks?.policies.some((p) => p.include.kind === "service-token-config")).toBe(false);
  });

  // The whole point of a separate exposure kind: public-web must never acquire
  // an Access app, and adding it must never strip one from a private host.
  test("public-web never yields an Access app, and app. keeps its gate", () => {
    const apps = accessAppsForPrivateWeb([
      { exposure: publicWeb(homelabTarget, { host: "hooks" }), policies: ["email-otp"] },
      { exposure: privateWeb(homelabTarget, { host: "app" }), policies: ["email-otp"] },
    ]);

    expect(apps.map((a) => a.domain)).toEqual(["app.worldwidewebb.co"]);
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

  // SUPERSEDED by #126: this host used to carry a CI service-token lock, from
  // when it was an internal tooling endpoint. It is now the public GitHub
  // receiver, and a service-token requirement would reject every delivery. The
  // replacement assertion lives in the "everyone bypass" test above.

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
