// Tunnel ingress + proxied DNS for control-center, a pure Pulumi-friendly
// declaration.
//
// The control-center app route is product-derived (productRoutes(), the
// `app.worldwidewebb.co` single-label host from the platform manifest). The
// flattened `app--cc.worldwidewebb.co` cutover host and the `${host}--${dnsCode}`
// scheme were retired in Task 7 Step C; the one imported legacy tooling host
// below (hooks-test) stays explicit as its own removal ticket.
//
// Ingress and CNAMEs are SEPARATE lists because the live state was not always
// symmetric: the retired `hooks-test` record was a CNAME with no ingress rule.
// They are symmetric today, but keeping the lists separate leaves room for the
// next asymmetric host without reshaping the model.
//
// captive-portal is intentionally absent from BOTH: it is LAN-only, reached over
// the OrbStack LoadBalancer on the mini's en1 (DESIGN §5a), never tunneled.

import { controlCenterProductManifest, type ProductServiceDeclaration } from "@www/platform";

/** The CNAME target every tunnel-routed hostname points at. */
export function tunnelCnameTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

/**
 * Per-origin connection options for an ingress rule.
 *
 * Everything routed here used to be a plaintext in-cluster Service, so the
 * origin was fully described by a `http://host:port` string. The LAN appliances
 * manage frames (ADR-0010) are not: they answer HTTPS with self-signed certs, so
 * cloudflared refuses them unless verification is disabled. That is required,
 * not cosmetic — an iframe cannot click through a certificate warning, so
 * without it the pane is permanently blank.
 */
export interface DesiredOriginRequest {
  /** Skip origin certificate verification. Self-signed LAN appliances only. */
  noTlsVerify?: boolean;
  /** SNI to present to the origin, when its cert names something else. */
  originServerName?: string;
}

/** A live tunnel ingress rule: hostname -> in-cluster origin. */
export interface DesiredIngressRule {
  hostname: string;
  // The origin the tunnel forwards to (`http://<service>:<port>`, or an
  // `https://<ip>:<port>` LAN appliance paired with `originRequest` below).
  service: string;
  originRequest?: DesiredOriginRequest;
}

/** A live proxied CNAME for a tunnel-routed hostname. */
export interface DesiredCname {
  hostname: string;
  proxied: true;
  target: (tunnelId: string) => string;
  // The record's CF `comment`, matching live EXACTLY. `undefined` = no comment.
  comment?: string;
}

export type CloudflareExposureSource = Readonly<{
  exposure: ProductServiceDeclaration["exposure"];
  origin: string;
  originRequest?: DesiredOriginRequest;
  comment?: string;
}>;

export type CloudflareRoutes = Readonly<{
  ingressRules: readonly DesiredIngressRule[];
  cnames: readonly DesiredCname[];
}>;

// LIVE tunnel ingress: no legacy hosts remain (only the product app host, added
// by productRoutes below). The dead `portainer` + `hooks` routes (origins removed
// in the Swarm->k8s migration) were pruned in www-oa74; `storybook` (origin
// deleted after the storybook rip) and `drizzle` (Drizzle Gateway torn down) were
// pruned here.
const LEGACY_INGRESS: Record<string, string> = {};

// LIVE proxied CNAMEs beyond the product-derived ones: none. The dead `hooks` +
// `portainer` CNAMEs were pruned in www-oa74; `storybook` and `drizzle` later;
// the `hooks-test` leftover went with the evee-webhooks tunnel in #127.
const LEGACY_CNAME_COMMENTS: Record<string, string | undefined> = {};

export function cloudflareRoutesForExposures(
  sources: readonly CloudflareExposureSource[],
): CloudflareRoutes {
  // Both web kinds get a tunnel route and a proxied CNAME; they differ only in
  // whether an Access app is declared for them (see access.ts, which filters on
  // "private-web" alone). Routing and gating are deliberately separate
  // decisions — conflating them is how a public host silently loses its gate.
  const exposed = sources.filter(
    (
      source,
    ): source is CloudflareExposureSource & {
      exposure: Extract<
        ProductServiceDeclaration["exposure"],
        { kind: "private-web" } | { kind: "public-web" }
      >;
    } => source.exposure?.kind === "private-web" || source.exposure?.kind === "public-web",
  );

  return {
    ingressRules: exposed.map((source) => ({
      hostname: source.exposure.hostname,
      service: source.origin,
      ...(source.originRequest ? { originRequest: source.originRequest } : {}),
    })),
    cnames: exposed.map((source) => ({
      hostname: source.exposure.hostname,
      proxied: true as const,
      target: tunnelCnameTarget,
      comment: source.comment,
    })),
  };
}

function productRoutes(): CloudflareRoutes {
  const cc = controlCenterProductManifest();

  const sources: CloudflareExposureSource[] = [
    {
      exposure: cc.app.exposure,
      origin: "http://web.control-center.svc.cluster.local:80",
      comment: "platform:control-center private app route",
    },
    {
      exposure: cc.hooks.exposure,
      // The api workload serves /hooks/github; the host is public, the origin
      // is the same in-cluster api every tRPC call already reaches.
      //
      // Cross-NAMESPACE origin, so the cluster-local FQDN is required: cloudflared
      // runs in `cloudflare`, the Service is `api` in `control-center`. A short
      // name resolves in the connector's own namespace and 502s (same reason
      // temporal-ui carries an FQDN).
      origin: "http://api.control-center.svc.cluster.local:4201",
      comment: "platform:github webhook receiver (public, HMAC-authenticated)",
    },
    {
      exposure: cc.temporalUi.exposure,
      // FQDN, not the short Service name: cloudflared runs in the
      // `control-center` namespace, so `temporal-ui` alone would not resolve
      // across into the `temporal` namespace.
      origin: "http://temporal-ui.temporal.svc.cluster.local:8080",
      comment: "platform:temporal web ui route",
    },
    {
      exposure: cc.dbUi.exposure,
      // FQDN, same cross-namespace reason as temporal-ui above: cloudflared
      // runs in `control-center`, pgAdmin runs in `db-ui`.
      origin: "http://db-ui.db-ui.svc.cluster.local:80",
      comment: "platform:pgAdmin multi-database web ui route (#65)",
    },
    {
      exposure: cc.grafana.exposure,
      // FQDN, not the short Service name: cloudflared runs in the `cloudflare`
      // namespace, so `grafana` alone would not resolve across into the
      // `observability` namespace.
      origin: "http://grafana.observability.svc.cluster.local:3000",
      comment: "platform:grafana web ui route",
    },
    {
      exposure: cc.services.manage.exposure,
      // manage (ADR-0010). Same shape as the app route above: a static nginx
      // bundle in the control-center namespace, cross-namespace from
      // cloudflared, so the FQDN is required.
      origin: "http://manage.control-center.svc.cluster.local:80",
      comment: "platform:manage management plane route (#292)",
    },
    {
      exposure: cc.unifi.exposure,
      // LAN appliance, not a cluster Service: the UniFi controller on the house
      // network. Self-signed cert, hence noTlsVerify.
      origin: "https://192.168.0.1",
      originRequest: { noTlsVerify: true },
      comment: "platform:unifi controller route (#292)",
    },
    {
      exposure: cc.dsm.exposure,
      // Synology DSM. .218 — NOT .219, which is a long-running
      // mis-transcription in this repo's history.
      origin: "https://192.168.0.218:5001",
      originRequest: { noTlsVerify: true },
      comment: "platform:synology dsm route (#292)",
    },
    {
      exposure: cc.ha.exposure,
      // FQDN, same cross-namespace reason as the others: cloudflared runs in
      // `cloudflare`, the `ha` ExternalName Service is in `control-center`
      // (api/worker reach it via the short name `http://ha:8123` from inside
      // that namespace; cloudflared cannot).
      origin: "http://ha.control-center.svc.cluster.local:8123",
      comment: "platform:home assistant web ui route (#75)",
    },
  ];

  return cloudflareRoutesForExposures(sources);
}

/** The live tunnel ingress rules for zone `<zone>` (adopt-only import target). */
export function desiredIngressRules(zone: string): DesiredIngressRule[] {
  return [
    ...productRoutes().ingressRules,
    ...Object.entries(LEGACY_INGRESS).map(([sub, service]) => ({
      hostname: `${sub}.${zone}`,
      service,
    })),
  ];
}

/** The live proxied CNAMEs for zone `<zone>` (adopt-only import target). */
export function desiredCnames(zone: string): DesiredCname[] {
  return [
    ...productRoutes().cnames,
    ...Object.entries(LEGACY_CNAME_COMMENTS).map(([sub, comment]) => ({
      hostname: `${sub}.${zone}`,
      proxied: true as const,
      target: tunnelCnameTarget,
      comment,
    })),
  ];
}
