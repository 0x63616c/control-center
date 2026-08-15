import { homelabTarget, internalService, privateWeb, publicWeb } from "@www/platform";
import { describe, expect, test } from "vitest";
import {
  cloudflareRoutesForExposures,
  desiredCnames,
  desiredIngressRules,
  tunnelCnameTarget,
} from "../src/routes.ts";

// These pin the LIVE state exactly. Ingress and CNAMEs are now symmetric: the
// stray hooks-test CNAME (which had no ingress rule) was deleted alongside the
// evee-webhooks tunnel in #127.
// dashboard.worldwidewebb.co removed in CC-2ff. The flattened
// app--cc.worldwidewebb.co cutover host was retired in Task 7 Step C (the product
// app route is now the single-label app.worldwidewebb.co). The dead portainer +
// hooks routes were pruned in www-oa74; storybook (origin deleted) and drizzle
// (Drizzle Gateway torn down) were pruned since. captive-portal is never tunneled
// (LAN-only).

const ZONE = "worldwidewebb.co";

describe("desiredIngressRules", () => {
  test("declares the product-derived private hosts, including the factory console, as ingress hosts", () => {
    const byHost = Object.fromEntries(
      desiredIngressRules(ZONE).map((r) => [r.hostname, r.service]),
    );
    expect(Object.keys(byHost).sort()).toEqual([
      "app.worldwidewebb.co",
      "codec.worldwidewebb.co",
      "db-ui.worldwidewebb.co",
      "dont-text-your-ex.worldwidewebb.co",
      "dsm.worldwidewebb.co",
      "factory.worldwidewebb.co",
      "grafana.worldwidewebb.co",
      "ha.worldwidewebb.co",
      "hooks.worldwidewebb.co",
      "manage.worldwidewebb.co",
      "temporal-ui.worldwidewebb.co",
      "unifi.worldwidewebb.co",
    ]);
    // #126: the public webhook relay forwards to the in-cluster API consumer.
    // Cross-namespace: cloudflared runs in `cloudflare`, the relay Service lives
    // in `webhook-relay`, so only the FQDN resolves. A short name here 502s.
    expect(byHost["hooks.worldwidewebb.co"]).toBe(
      "http://relay.webhook-relay.svc.cluster.local:8080",
    );
    // Cross-NAMESPACE origin: cloudflared runs in control-center, so only the
    // cluster-local FQDN resolves the Service in `temporal`.
    expect(byHost["temporal-ui.worldwidewebb.co"]).toBe(
      "http://temporal-ui.temporal.svc.cluster.local:8080",
    );
    expect(byHost["codec.worldwidewebb.co"]).toBe(
      "http://codec.software-factory.svc.cluster.local:8080",
    );
    expect(byHost["db-ui.worldwidewebb.co"]).toBe("http://db-ui.db-ui.svc.cluster.local:80");
    // #209: same cross-NAMESPACE rule — the Grafana Service lives in
    // `observability`, so a bare `grafana` origin would 502.
    expect(byHost["grafana.worldwidewebb.co"]).toBe(
      "http://grafana.observability.svc.cluster.local:3000",
    );
    // #75/#237: same cross-NAMESPACE rule — the `ha` ExternalName Service lives
    // in `control-center`, so a bare `ha` origin from `cloudflare` would 502.
    expect(byHost["ha.worldwidewebb.co"]).toBe("http://ha.control-center.svc.cluster.local:8123");
    // #292: manage, same cross-namespace FQDN rule as the app route.
    expect(byHost["manage.worldwidewebb.co"]).toBe(
      "http://manage.control-center.svc.cluster.local:80",
    );
    expect(byHost["factory.worldwidewebb.co"]).toBe(
      "http://web.software-factory.svc.cluster.local:80",
    );
    const dontTextYourExRules = desiredIngressRules(ZONE).filter(
      (rule) => rule.hostname === "dont-text-your-ex.worldwidewebb.co",
    );
    expect(dontTextYourExRules).toEqual([
      {
        hostname: "dont-text-your-ex.worldwidewebb.co",
        path: "^/api(?:/.*)?$",
        service: "http://api.dont-text-your-ex.svc.cluster.local:8787",
      },
      {
        hostname: "dont-text-your-ex.worldwidewebb.co",
        service: "http://frontend.dont-text-your-ex.svc.cluster.local:80",
      },
    ]);
    expect(byHost["api.worldwidewebb.co"]).toBeUndefined();
    expect(byHost["dashboard.worldwidewebb.co"]).toBeUndefined();
    expect(byHost["storybook.worldwidewebb.co"]).toBeUndefined();
    expect(byHost["drizzle.worldwidewebb.co"]).toBeUndefined();
    // Task 7 Step C: the flattened app--cc cutover host is retired.
    expect(byHost["app--cc.worldwidewebb.co"]).toBeUndefined();
    expect(byHost["app.worldwidewebb.co"]).toBe("http://web.control-center.svc.cluster.local:80");
    expect(byHost["portainer.worldwidewebb.co"]).toBeUndefined();
  });

  // #292/ADR-0010: the two LAN appliances manage frames are the first origins
  // that are not plaintext in-cluster Services. Both answer HTTPS with a
  // self-signed cert, so cloudflared refuses them without noTlsVerify — and an
  // iframe cannot click through a cert warning, so the pane would be
  // permanently blank rather than merely ugly.
  test("the LAN appliances route over https with origin verification disabled", () => {
    const byHost = Object.fromEntries(desiredIngressRules(ZONE).map((r) => [r.hostname, r]));

    expect(byHost["unifi.worldwidewebb.co"].service).toBe("https://192.168.0.1");
    expect(byHost["unifi.worldwidewebb.co"].originRequest).toEqual({ noTlsVerify: true });
    // .218, NOT .219 — a recurring mis-transcription in this repo's history.
    expect(byHost["dsm.worldwidewebb.co"].service).toBe("https://192.168.0.218:5001");
    expect(byHost["dsm.worldwidewebb.co"].originRequest).toEqual({ noTlsVerify: true });
  });

  // Every other rule must stay byte-identical to live, so originRequest is
  // OMITTED rather than rendered empty — an added key is a real tunnel-config diff.
  test("origins that need no options declare none", () => {
    for (const rule of desiredIngressRules(ZONE)) {
      if (rule.service.startsWith("http://")) {
        expect(rule.originRequest, rule.hostname).toBeUndefined();
      }
    }
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

  // Routing and Access-gating are separate decisions: a public-web host must get
  // a tunnel route and a CNAME exactly like a private one, and differ ONLY in
  // whether access.ts declares an app for it (asserted in access.test.ts).
  test("routes public-web hosts alongside private-web ones", () => {
    const routes = cloudflareRoutesForExposures([
      { exposure: privateWeb(homelabTarget, { host: "app" }), origin: "http://cc-web:80" },
      { exposure: publicWeb(homelabTarget, { host: "hooks" }), origin: "http://cc-api:4201" },
    ]);

    expect(routes.ingressRules.map((r) => r.hostname).sort()).toEqual([
      "app.worldwidewebb.co",
      "hooks.worldwidewebb.co",
    ]);
    expect(routes.cnames.map((c) => c.hostname).sort()).toEqual([
      "app.worldwidewebb.co",
      "hooks.worldwidewebb.co",
    ]);
    expect(routes.cnames.every((c) => c.proxied)).toBe(true);
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
  test("declares exactly the product-derived CNAMEs, with no legacy leftovers", () => {
    const hosts = desiredCnames(ZONE)
      .map((c) => c.hostname)
      .sort();
    expect(hosts).toEqual([
      "app.worldwidewebb.co",
      "codec.worldwidewebb.co",
      "db-ui.worldwidewebb.co",
      "dont-text-your-ex.worldwidewebb.co",
      "dsm.worldwidewebb.co",
      "factory.worldwidewebb.co",
      "grafana.worldwidewebb.co",
      "ha.worldwidewebb.co",
      "hooks.worldwidewebb.co",
      "manage.worldwidewebb.co",
      "temporal-ui.worldwidewebb.co",
      "unifi.worldwidewebb.co",
    ]);
    // #127: the EVEE-218 hooks-test leftover was deleted with the old tunnel.
    expect(hosts).not.toContain("hooks-test.worldwidewebb.co");
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
    // #127: the EVEE-218 leftover is gone, comment and all.
    expect(byHost).not.toHaveProperty("hooks-test.worldwidewebb.co");
    // product-derived platform route comment (not a frozen legacy value)
    expect(byHost["app.worldwidewebb.co"]).toBe("platform:control-center private app route");
    expect(byHost["temporal-ui.worldwidewebb.co"]).toBe("platform:temporal web ui route");
    expect(byHost["grafana.worldwidewebb.co"]).toBe("platform:grafana web ui route");
    expect(byHost["ha.worldwidewebb.co"]).toBe("platform:home assistant web ui route (#75)");
    expect(byHost["hooks.worldwidewebb.co"]).toBe(
      "platform:github webhook relay (public, HMAC-authenticated)",
    );
    expect(byHost["dont-text-your-ex.worldwidewebb.co"]).toBe(
      "platform:don't text your ex public app route",
    );
    // Task 7 Step C: the flattened app--cc cutover CNAME is retired.
    expect(byHost).not.toHaveProperty("app--cc.worldwidewebb.co");
    // pruned dead routes are absent (www-oa74; storybook + drizzle pruned since)
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
