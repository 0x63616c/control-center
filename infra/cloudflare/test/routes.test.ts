import { homelabTarget, internalService, privateWeb } from "@www/platform";
import { describe, expect, test } from "vitest";
import {
  cloudflareRoutesForExposures,
  desiredCnames,
  desiredIngressRules,
  tunnelCnameTarget,
} from "../src/routes.ts";

// ADOPT-ONLY (www-j934.2): the ingress rules + CNAMEs must mirror the LIVE state
// exactly. Ingress = just the product app host; CNAMEs = the product app host
// PLUS the stray hooks-test leftover (asymmetric on purpose).
// dashboard.worldwidewebb.co removed in CC-2ff. The flattened
// app--cc.worldwidewebb.co cutover host was retired in Task 7 Step C (the product
// app route is now the single-label app.worldwidewebb.co). The dead portainer +
// hooks routes were pruned in www-oa74; storybook (origin deleted) and drizzle
// (Drizzle Gateway torn down) were pruned since. captive-portal is never tunneled
// (LAN-only).

const ZONE = "worldwidewebb.co";

describe("desiredIngressRules", () => {
  test("declares the product-derived app + temporal-ui hosts as the only ingress hosts", () => {
    const byHost = Object.fromEntries(
      desiredIngressRules(ZONE).map((r) => [r.hostname, r.service]),
    );
    expect(Object.keys(byHost).sort()).toEqual([
      "app.worldwidewebb.co",
      "temporal-ui.worldwidewebb.co",
    ]);
    // Cross-NAMESPACE origin: cloudflared runs in control-center, so only the
    // cluster-local FQDN resolves the Service in `temporal`.
    expect(byHost["temporal-ui.worldwidewebb.co"]).toBe(
      "http://temporal-ui.temporal.svc.cluster.local:8080",
    );
    expect(byHost["dashboard.worldwidewebb.co"]).toBeUndefined();
    expect(byHost["storybook.worldwidewebb.co"]).toBeUndefined();
    expect(byHost["drizzle.worldwidewebb.co"]).toBeUndefined();
    // Task 7 Step C: the flattened app--cc cutover host is retired.
    expect(byHost["app--cc.worldwidewebb.co"]).toBeUndefined();
    expect(byHost["app.worldwidewebb.co"]).toBe("http://web.control-center.svc.cluster.local:80");
    expect(byHost["portainer.worldwidewebb.co"]).toBeUndefined();
    expect(byHost["hooks.worldwidewebb.co"]).toBeUndefined();
  });

  test("captive-portal is NEVER tunneled (LAN-only)", () => {
    const hosts = desiredIngressRules(ZONE).map((r) => r.hostname);
    expect(hosts).not.toContain("captive-portal.worldwidewebb.co");
    expect(hosts).not.toContain("app--cp.worldwidewebb.co");
  });

  test("the retired app--cc cutover host never reappears in the ingress", () => {
    const hosts = desiredIngressRules(ZONE).map((r) => r.hostname);
    expect(hosts).not.toContain("app--cc.worldwidewebb.co");
    expect(hosts.some((h) => h.includes("--"))).toBe(false);
  });

  // .7.4 contract: /trpc is same-origin behind app.cc, so the api service is
  // internal-only. No api.cc.* external hostname may ever leak into the shipped
  // ingress (the primitive-level guard lives in exposure.test.ts; this asserts it
  // end-to-end over the REAL control-center routes, not a synthetic product).
  test("never emits an external api.cc route (same-origin /trpc)", () => {
    const hosts = desiredIngressRules(ZONE).map((r) => r.hostname);
    expect(hosts).not.toContain("api--cc.worldwidewebb.co");
    expect(hosts.some((h) => h.startsWith("api.cc."))).toBe(false);
  });

  test("renders private product route shapes without undeclared APIs", () => {
    const routes = cloudflareRoutesForExposures([
      {
        exposure: privateWeb(homelabTarget, { host: "app" }),
        origin: "http://cp-web:80",
      },
      {
        exposure: privateWeb(homelabTarget, { host: "web" }),
        origin: "http://cc-web:80",
      },
      { exposure: internalService({ port: 4201 }), origin: "http://internal:4201" },
    ]);

    expect(routes.ingressRules.map((route) => route.hostname).sort()).toEqual([
      "app.worldwidewebb.co",
      "web.worldwidewebb.co",
    ]);
    expect(routes.cnames.map((route) => route.hostname).sort()).toEqual([
      "app.worldwidewebb.co",
      "web.worldwidewebb.co",
    ]);
    expect(routes.ingressRules.map((route) => route.hostname)).not.toContain(
      "api.worldwidewebb.co",
    );
  });
});

describe("desiredCnames", () => {
  test("declares the product-derived app CNAME plus legacy proxied CNAMEs incl. stray hooks-test", () => {
    const hosts = desiredCnames(ZONE)
      .map((c) => c.hostname)
      .sort();
    expect(hosts).toEqual([
      "app.worldwidewebb.co",
      "hooks-test.worldwidewebb.co",
      "temporal-ui.worldwidewebb.co",
    ]);
    // Task 7 Step C: the flattened app--cc cutover CNAME is retired.
    expect(hosts).not.toContain("app--cc.worldwidewebb.co");
  });

  test("every CNAME is proxied and targets the tunnel", () => {
    const tunnelId = "abc123";
    for (const c of desiredCnames(ZONE)) {
      expect(c.proxied).toBe(true);
      expect(c.target(tunnelId)).toBe(`${tunnelId}.cfargotunnel.com`);
    }
  });

  test("each CNAME carries its EXACT live comment (zero-diff import; varies per record)", () => {
    const byHost = Object.fromEntries(desiredCnames(ZONE).map((c) => [c.hostname, c.comment]));
    // dashboard.worldwidewebb.co retired in CC-2ff
    expect(byHost).not.toHaveProperty("dashboard.worldwidewebb.co");
    // legacy evee comment (kept verbatim so import is zero-diff)
    expect(byHost["hooks-test.worldwidewebb.co"]).toBe(
      "EVEE-218 webhook test (apex naming, covered by Universal SSL)",
    );
    // product-derived platform route comment (not a frozen legacy value)
    expect(byHost["app.worldwidewebb.co"]).toBe("platform:control-center private app route");
    expect(byHost["temporal-ui.worldwidewebb.co"]).toBe("platform:temporal web ui route");
    // Task 7 Step C: the flattened app--cc cutover CNAME is retired.
    expect(byHost).not.toHaveProperty("app--cc.worldwidewebb.co");
    // pruned dead routes are absent (www-oa74; storybook + drizzle pruned since)
    expect(byHost).not.toHaveProperty("hooks.worldwidewebb.co");
    expect(byHost).not.toHaveProperty("portainer.worldwidewebb.co");
    expect(byHost).not.toHaveProperty("storybook.worldwidewebb.co");
    expect(byHost).not.toHaveProperty("drizzle.worldwidewebb.co");
  });
});

describe("tunnelCnameTarget", () => {
  test("builds the cfargotunnel host", () => {
    expect(tunnelCnameTarget("t-xyz")).toBe("t-xyz.cfargotunnel.com");
  });
});
