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

/** A live tunnel ingress rule: hostname -> in-cluster origin. */
export interface DesiredIngressRule {
  hostname: string;
  // The origin the tunnel forwards to (`http://<service>:<port>`).
  service: string;
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
