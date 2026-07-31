// Cloudflare Access surface for control-center (www-cuuw), a pure
// Pulumi-friendly declaration. Private product hosts must be born locked, while
// legacy hosts remain explicit until their cutover tickets retire them.

// CF token verification NOTE (www-j934.2): the admin token
// (CLOUDFLARE_API__CREDENTIAL in vault) is ACCOUNT-OWNED, so it verifies via
// GET /accounts/{account_id}/tokens/verify, NOT /user/tokens/verify (the user
// endpoint fails account-owned tokens by design). It already carries the account
// + zone scopes incl. DNS:Edit. Don't re-trip the /user verify dead end.

import { controlCenterProductManifest, type ProductServiceDeclaration } from "@www/platform";

// kioskTokenId: the CF service token *id* (UUID) for the kiosk token — NOT
// the client_id (.access suffix). Access policies reference token_id; the
// client_id is only sent in CF-Access-Client-Id headers by the iOS kiosk app.
type AccessConfigKey = "allowedEmail" | "ciClientId" | "kioskTokenId" | "factoryServiceTokenId";

export type AccessInclude =
  | Readonly<{ kind: "email-config"; configKey: "allowedEmail" }>
  | Readonly<{ kind: "service-token-config"; configKey: Exclude<AccessConfigKey, "allowedEmail"> }>
  | Readonly<{ kind: "everyone" }>;

type DesiredAccessPolicy = Readonly<{
  name: string;
  // "non_identity" is CF's "Service Auth" action: it validates the service-token
  // headers on the request directly and short-circuits with a CF_Authorization
  // cookie. "allow" is identity-based, so a service token presented to an "allow"
  // policy is recognized (service_token_status:true) but NOT authorized
  // (auth_status:NONE) — CF redirects to the IdP login. Headless callers
  // (iPad kiosk, CI) MUST use non_identity. (www-azu2 root-cause: CC-d15 gate.)
  decision: "allow" | "deny" | "non_identity";
  precedence: number;
  include: AccessInclude;
}>;

/** A desired Access application: one gated domain plus its explicit policies. */
export interface DesiredAccessApp {
  // The single hostname this app gates.
  domain: string;
  // The app type as CF models it (the live apps are self_hosted).
  type: "self_hosted";
  policies: readonly DesiredAccessPolicy[];
  // Ownership tag the live apps already carry, so importing them is a zero-diff.
  // The literal value is a frozen legacy string baked into live Cloudflare state;
  // renaming it would be a destructive replace, so it is intentionally immutable.
  tag: string;
}

// Frozen legacy ownership tag matching the live Cloudflare app metadata exactly
// (see DesiredAccessApp.tag). Immutable: changing it forces a destructive replace.
const OWNERSHIP_TAG = "bosun:control-center";

export type PrivateWebAccessSource = Readonly<{
  exposure: ProductServiceDeclaration["exposure"];
  policies: readonly ("email-otp" | "kiosk-service-token" | "factory-service-token")[];
}>;

function accessApp(domain: string, policies: readonly DesiredAccessPolicy[]): DesiredAccessApp {
  return {
    domain,
    type: "self_hosted",
    policies,
    tag: OWNERSHIP_TAG,
  };
}

function emailOtpPolicy(): DesiredAccessPolicy {
  return {
    name: "email-otp",
    decision: "allow",
    precedence: 1,
    include: { kind: "email-config", configKey: "allowedEmail" },
  };
}

function serviceTokenPolicy(
  name: "ci-service-token" | "kiosk-service-token" | "factory-service-token",
  configKey: "ciClientId" | "kioskTokenId" | "factoryServiceTokenId",
): DesiredAccessPolicy {
  return {
    name,
    // Service Auth (non_identity), NOT allow — see DesiredAccessPolicy.decision.
    decision: "non_identity",
    precedence: 1,
    include: { kind: "service-token-config", configKey },
  };
}

function wildcardBlockFloor(zone: string): DesiredAccessApp {
  return accessApp(`*.${zone}`, [
    {
      name: "default-deny",
      decision: "deny",
      precedence: 99,
      include: { kind: "everyone" },
    },
  ]);
}

export function accessAppsForPrivateWeb(
  sources: readonly PrivateWebAccessSource[],
): DesiredAccessApp[] {
  return sources
    .filter(
      (
        source,
      ): source is PrivateWebAccessSource & {
        exposure: Extract<ProductServiceDeclaration["exposure"], { kind: "private-web" }>;
      } => source.exposure?.kind === "private-web",
    )
    .map((source) =>
      accessApp(
        source.exposure.hostname,
        source.policies.map((p, i) => {
          const policy =
            p === "kiosk-service-token"
              ? serviceTokenPolicy("kiosk-service-token", "kioskTokenId")
              : p === "factory-service-token"
                ? serviceTokenPolicy("factory-service-token", "factoryServiceTokenId")
                : emailOtpPolicy();
          return { ...policy, precedence: i + 1 };
        }),
      ),
    );
}

/**
 * The desired Access apps for zone `<zone>`.
 *
 * `includeGate` (default false) toggles ONLY the NOT-YET-LIVE additions of the
 * zone-wide access gate (www-cuuw): the `*.<zone>` default-DENY floor and the
 * `hooks` CI lock. It is OFF by default because the floor's wildcard also catches
 * any currently PUBLIC host that lacks an explicit allow above it. Enabling it
 * before each such host has an explicit bypass would lock it out (www-b6ad).
 *
 * Always returned (safe to apply independent of the floor): the per-product
 * control-center private-route app (it gates the product host itself). The
 * `storybook` app was pruned here (origin deleted after the storybook rip); the
 * `drizzle` email-OTP app was pruned here (Drizzle Gateway torn down).
 */
export function desiredAccessApps(zone: string, includeGate = false): DesiredAccessApp[] {
  const ccManifest = controlCenterProductManifest();

  const baseApps: DesiredAccessApp[] = [
    // Private-web products: the CC app (app.worldwidewebb.co, product-derived from
    // the platform manifest) uses a kiosk service-token (iPad wall panel, not
    // human login) plus an email-OTP fallback for browser access (CC-d15).
    ...accessAppsForPrivateWeb([
      { exposure: ccManifest.app.exposure, policies: ["kiosk-service-token", "email-otp"] },
      // Temporal UI: email-OTP ONLY, deliberately no kiosk service token. The
      // wall panel has no business reaching it, and the UI can terminate and
      // reset running workflows — so it stays behind a human login.
      { exposure: ccManifest.temporalUi.exposure, policies: ["email-otp"] },
      // Browser-side payload decoding must authenticate to the codec with the
      // same human Access session as Temporal UI; this is never a public
      // decryption endpoint.
      { exposure: ccManifest.codec.exposure, policies: ["email-otp"] },
      // pgAdmin (#65): same treatment as Temporal UI — a database admin
      // surface with full read/write, no kiosk business reaching it.
      { exposure: ccManifest.dbUi.exposure, policies: ["email-otp"] },
      // Grafana: email-OTP ONLY, for the same reason as the Temporal UI. The
      // panel never calls Grafana, so it gets no kiosk service token, and the
      // UI can edit datasources and dashboards — a human login only.
      { exposure: ccManifest.grafana.exposure, policies: ["email-otp"] },
      // Home Assistant (#75/#237): email-OTP ONLY, same reasoning as Grafana —
      // full admin surface, no kiosk business reaching it over this route.
      { exposure: ccManifest.ha.exposure, policies: ["email-otp"] },
      // manage (#292/ADR-0010): email-OTP ONLY. manage has no login of its own
      // and no session store — this app IS its authentication, so it is not
      // optional and it never gets a service token.
      { exposure: ccManifest.services.manage.exposure, policies: ["email-otp"] },
      // The two LAN appliances manage frames. Both were previously reachable
      // only on the LAN; putting them on the tunnel gives them an internet-facing
      // hostname, so the Access app is what keeps that from meaning
      // internet-facing UniFi and DSM logins. email-OTP only, never a token.
      { exposure: ccManifest.unifi.exposure, policies: ["email-otp"] },
      { exposure: ccManifest.dsm.exposure, policies: ["email-otp"] },
      // Factory needs both Service Auth for headless callers and an Allow
      // policy so a browser can rely on the Cloudflare Access JWT.
      {
        exposure: ccManifest.factoryConsole.exposure,
        policies: ["factory-service-token", "email-otp"],
      },
    ]),
  ];

  if (!includeGate) return baseApps;

  return [
    wildcardBlockFloor(zone),
    ...baseApps,
    // hooks. is PUBLIC (#126): GitHub posts to it from the internet and its auth
    // is an HMAC, not Access. The wildcard floor above would otherwise sweep it
    // into default-deny the moment the gate is switched on, breaking deliveries
    // with no code change on our side — so the bypass is declared HERE, next to
    // the floor, rather than left to be debugged later.
    //
    // This replaces the old CI service-token lock on this host: that predates
    // the host being a public receiver, and a service-token requirement would
    // reject every GitHub delivery.
    accessApp(`hooks.${zone}`, [
      { name: "public-bypass", decision: "allow", precedence: 1, include: { kind: "everyone" } },
    ]),
  ];
}
