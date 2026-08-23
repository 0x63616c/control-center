// Pulumi program for the control-center Cloudflare edge state.
//
// LIVE DEPLOY TARGET (was adopt-only at import, www-j934.2; promoted www-kbiy).
// This stack now drives the live Cloudflare edge: tunnel ingress routing, proxied
// DNS, and per-product Access apps. The original "mirror, do not apply" import era
// is over, `pulumi up` here is a real prod mutation. Every durable resource is
// still `protect: true`; the DTYE Worker route alone is intentionally
// recoverable so emergency removal falls back to the origin limiter.
//
// CI OWNS THIS PROJECT NOW (www-cred is done): `.github/workflows/ci.yml` has a
// `deploy-cloudflare` job that runs `pulumi up` on push to `main`. It is gated
// on the `cloudflareinfra` paths filter — `infra/cloudflare/**` plus
// `packages/platform/src/index.ts`, because `controlCenterProductManifest()`
// feeds `desiredAccessApps()` and `productRoutes()`, so a manifest-only change
// with no diff in this directory must still redeploy. The job runs AFTER
// `deploy-home-server`, not in parallel: a tunnel-ingress rule that applied
// before its k8s backend existed would 502 for real users, whereas an unrouted
// backend just sits inert. A local `pulumi up` here is now a manual override of
// CI, not the normal path.
//
// The zone-wide ACCESS GATE (default-deny *.<zone> floor + tooling locks, www-cuuw)
// is flag-gated OFF by `applyAccessGate` (see below): applying the floor would
// block any currently-public host without an explicit bypass (the live dashboard
// panel), so it stays off until www-cuuw/www-b6ad add those.
//
// Config (all via `pulumi config set [--secret]`, NEVER literals):
//   cloudflare apiToken   CLOUDFLARE_API__CREDENTIAL in vault (account-owned;
//                          verify via GET /accounts/{account_id}/tokens/verify,
//                          NOT /user/tokens/verify)
//   accountId / zoneId / zoneName              CLOUDFLARE_API__* in vault
//   tunnelSecret                               the managed tunnel's password;
//                          REPLACE-FORCING, so never rotate it in place
//   allowedEmail                               the OTP allow email (PII; SECRET config)
//   factoryServiceTokenId                      factory caller service-token ID (SECRET config)

import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import { type AccessInclude, desiredAccessApps } from "./src/access.ts";
import { desiredCnames, desiredIngressRules } from "./src/routes.ts";
import { createDontTextYourExWorkerRoute } from "./src/worker-route.ts";

const cfg = new pulumi.Config();
// zoneName is the public domain (plaintext). The account/zone/tunnel ids + the
// allow email are SECRET config (encrypted in Pulumi.prod.yaml): this is a PUBLIC
// repo and those identifiers are deliberately kept out of it (same rule as the
// deploy.config.ts op-secret channel). All sourced from op at `pulumi config set`.
const zoneName = cfg.require("zoneName");
const accountId = cfg.requireSecret("accountId");
const zoneId = cfg.requireSecret("zoneId");
// applyAccessGate gates the zone-wide access gate (www-cuuw): the *.<zone>
// default-deny floor + tooling locks. Default false so the floor never blocks a
// currently-public host (the live dashboard panel) before each
// has an explicit bypass (www-b6ad). The per-product control-center route Access app is
// always applied. Flip via: pulumi config set applyAccessGate true --stack prod
const applyAccessGate = cfg.getBoolean("applyAccessGate") ?? false;
function accessInclude(
  include: AccessInclude,
): cloudflare.types.input.ZeroTrustAccessPolicyInclude {
  switch (include.kind) {
    case "email-config":
      return { emails: [cfg.requireSecret(include.configKey)] };
    case "service-token-config":
      return { serviceTokens: [cfg.requireSecret(include.configKey)] };
    case "everyone":
      return { everyone: true };
  }
}

// Provider authenticated by the account-owned API token (secret config).
//
// version is PINNED to match the @pulumi/cloudflare SDK major (v5). Pulumi
// otherwise auto-downloads the "latest" plugin (v6, a major CF-provider rewrite
// with a different zero_trust_access_application schema); a v6 plugin writing
// import state that the v5 SDK then diffs throws "State version 500 > schema
// version 0". Pinning keeps import + diff + SDK on one schema, and makes CI
// reproducible (www-j934.2). Bumping to v6 is a separate, deliberate upgrade.
const provider = new cloudflare.Provider(
  "cf",
  { apiToken: cfg.requireSecret("apiToken") },
  { version: "5.49.1" },
);
const opts: pulumi.CustomResourceOptions = { provider, protect: true };

// Stable Pulumi resource name from a hostname ("app.worldwidewebb.co" →
// "app"). Strips the zone suffix to a single-label record name (each host is a
// single label under the zone, so each route is already distinct, www-kbiy).
const sub = (host: string) => host.replace(`.${zoneName}`, "");

const accessName = (host: string) =>
  host.replace(`.${zoneName}`, "").replace("*", "wildcard").replaceAll(".", "-");

// --- Access apps + policies ---
// The provider derives selfHostedDomains from `name` for single-domain apps, so
// declaring it there would show a spurious update. The Temporal UI/codec pair is
// the deliberate exception: it needs one multi-domain app to share an Access
// session. sessionDuration is another exception (www-178): we deliberately
// override CF's 24h default so a human login/OTP lasts 30 days.
//
// accessAppAuds (#593): each app's audience tag, keyed by domain, exported
// below so the home-server Pulumi project can read a consumer's AUD via
// StackReference instead of a hand-pasted vault secret. The audience is
// derived infra state minted by THIS resource, not a value anyone should be
// copying into secrets/vault.yaml by hand.
//
// A consumer's FIRST deploy therefore takes two passes, and that is expected:
// this project only runs after `deploy-home-server` succeeds (see the
// deploy-cloudflare `needs` in ci.yml), so on pass one the consumer reads an
// empty AUD, and only on the next run does it see the real one. That is safe
// because the consumer fails closed — the factory API refuses to start on an
// empty CLOUDFLARE_ACCESS_AUD rather than serving unauthenticated traffic, and
// its Deployment carries `pulumi.com/skipAwait` so the resulting CrashLoopBackOff
// does not fail everything else in the cluster's `pulumi up`.
//
// The corollary is a gotcha worth knowing: a change that touches only the
// consumer (or only the vault) does NOT re-run this project, because the
// `cloudflareinfra` path filter never fires. A new Access-gated hostname needs
// at least one commit under `infra/cloudflare/**` before its app exists at all.
const accessAppAuds: Record<string, pulumi.Output<string>> = {};

for (const app of desiredAccessApps(zoneName, applyAccessGate)) {
  const name = accessName(app.domain);
  const cfApp = new cloudflare.ZeroTrustAccessApplication(
    name,
    {
      accountId,
      name: app.domain,
      // The CF API (v5.49.1) requires `domain` (or destinations) on CREATE of a
      // self-hosted app: "domain or destinations must be set (12130)". The
      // imported legacy apps had it populated from import; new ones must set it.
      domain: app.domain,
      ...(app.domains.length > 1 ? { selfHostedDomains: [...app.domains] } : {}),
      ...(app.cors
        ? {
            corsHeaders: [
              {
                allowCredentials: app.cors.allowCredentials,
                allowedHeaders: [...app.cors.allowedHeaders],
                allowedMethods: [...app.cors.allowedMethods],
                allowedOrigins: [...app.cors.allowedOrigins],
                maxAge: app.cors.maxAge,
              },
            ],
          }
        : {}),
      type: app.type,
      httpOnlyCookieAttribute: true,
      sessionDuration: "720h",
      tags: [app.tag],
    },
    opts,
  );
  accessAppAuds[app.domain] = cfApp.aud;

  for (const policy of app.policies) {
    new cloudflare.ZeroTrustAccessPolicy(
      `${name}-${policy.name}`,
      {
        accountId,
        // Live policies are app-scoped; the provider models the link via applicationId.
        applicationId: cfApp.id,
        name: policy.name,
        decision: policy.decision,
        precedence: policy.precedence,
        includes: [accessInclude(policy.include)],
      },
      opts,
    );
  }
}

// --- The project-owned tunnel (#127) ---
// Replaces the inherited `evee-webhooks` tunnel. Created BY Pulumi, which is what
// makes `tunnelToken` an output instead of a hand-copied SOPS key.
//
// `secret` is REQUIRED and REPLACE-FORCING, and the CF API never returns it after
// creation. So: never rotate this value in place (that destroys and recreates the
// tunnel, i.e. a repeat of the whole cutover) - regenerate the CONNECTOR TOKEN
// instead, which does not replace the tunnel.
const managedTunnel = new cloudflare.ZeroTrustTunnelCloudflared(
  "tunnel-world-wide-webb",
  {
    accountId,
    name: "world-wide-webb",
    // Ingress lives in the ZeroTrustTunnelCloudflaredConfig below (remotely
    // managed), not in a local cloudflared config.yaml.
    configSrc: "cloudflare",
    secret: cfg.requireSecret("tunnelSecret"),
  },
  opts,
);

// The connector token cloudflared runs with. Secret output: consumed via
// `pulumi stack output --show-secrets` into SOPS, never printed.
export const managedTunnelToken = managedTunnel.tunnelToken;
export const managedTunnelId = managedTunnel.id;

// --- Tunnel ingress config ---
// A single ZeroTrustTunnelCloudflaredConfig holds all ingress rules in order,
// ending in the catchall http_status:404.
new cloudflare.ZeroTrustTunnelCloudflaredConfig(
  "tunnel-config-managed",
  {
    accountId,
    tunnelId: managedTunnel.id,
    config: {
      ingressRules: [
        ...desiredIngressRules(zoneName).map((r) => ({
          hostname: r.hostname,
          ...(r.path ? { path: r.path } : {}),
          service: r.service,
          // Only rendered for the origins that declare it (the self-signed LAN
          // appliances); omitted entirely elsewhere so existing rules stay a
          // zero-diff against live.
          ...(r.originRequest ? { originRequest: r.originRequest } : {}),
        })),
        { service: "http_status:404" },
      ],
    },
  },
  opts,
);

// --- Proxied DNS CNAMEs -> the tunnel (adopt-only) ---
// Field set mirrors the imported records EXACTLY so the import is zero-diff:
// `name` is the SUBDOMAIN only ("hooks-test", not the FQDN, the v5 provider
// stores the short name and changing it forces a destructive replace), `comment`
// is each record's exact live value (varies; undefined = no comment), ttl 1 =
// "automatic", proxied. `content` is the tunnel target (tunnelId from config =
// the live tunnel UUID, so the target matches live).
//
// KNOWN v5 IMPORT ARTIFACT (benign, self-heals on apply):
// `pulumi preview` shows each Record with a benign `~ update [+content,
// +allowOverwrite]`. This is NOT drift: @pulumi/cloudflare 5.49.1 does not
// round-trip a proxied CNAME's `content` (or the input-only `allowOverwrite`) on
// `pulumi import`, so import recorded content=null while the program supplies the
// VALUE-IDENTICAL live target (verified: live `dig`/API content ==
// <tunnelId>.cfargotunnel.com). The update is a no-op that self-heals on apply
// (www-kbiy promoted this stack to a live deploy target).
for (const c of desiredCnames(zoneName)) {
  new cloudflare.Record(
    sub(c.hostname),
    {
      zoneId,
      name: sub(c.hostname),
      type: "CNAME",
      // The tunnel id is an Output, so build the target via interpolate.
      content: pulumi.interpolate`${managedTunnel.id}.cfargotunnel.com`,
      proxied: c.proxied,
      ttl: 1,
      ...(c.comment ? { comment: c.comment } : {}),
    },
    opts,
  );
}

// The script and its RateLimit bindings are deployed by Wrangler before this
// Pulumi program runs. Keeping route ownership here preserves the edge topology
// in the authoritative stack while avoiding a Cloudflare provider v6 migration.
const dontTextYourExWorkerRoute = createDontTextYourExWorkerRoute({
  zoneId,
  zoneName,
  provider,
});
export const dontTextYourExWorkerRouteId = dontTextYourExWorkerRoute.id;

// TLS: every host is a single label under the zone (`app.worldwidewebb.co`),
// so Cloudflare's free Universal SSL `*.worldwidewebb.co` (one-level wildcard)
// covers every product route automatically. No ACM / CertificatePack needed
// (removed in www-kbiy).

export const summary = {
  zoneName,
  accessApps: desiredAccessApps(zoneName, applyAccessGate).map((a) => a.domain),
  ingressHosts: desiredIngressRules(zoneName).map((r) => r.hostname),
  cnames: desiredCnames(zoneName).map((c) => c.hostname),
};

// Consumed cross-project by infra/program.ts via `pulumi.StackReference`
// (#593) — e.g. the software-factory API needs `factory.<zone>`'s AUD to
// validate Access JWTs, and reading it here rather than a vault secret means
// a recreated app (a destructive replace, since `tag` and `domain` are
// immutable) can never leave a stale AUD silently accepted downstream.
export { accessAppAuds };
