// UniFi network config as Pulumi resources (www-j934.3), via @pulumiverse/unifi
// (the filipowm/unifi Terraform provider bridged into Pulumi).
//
// ADOPT-ONLY (GOAL.md Boundary 1): every resource here mirrors a live object on
// the UCG-Fiber controller (Network 10.4.57). Each existing resource is
// `pulumi import`-ed by its UniFi `_id` and carries `protect: true`, and the
// first `pulumi preview` after import MUST show 0-to-create/delete/replace
// before ANY apply. NOTHING here may modify an existing resource.
//
// The www-guest VLAN + SSID are NEW (additive-only) resources, gated behind the
// `unifi:applyGuest` config flag so the import-only phase declares ONLY the
// adopted resources (a clean zero-diff preview), and the guest network is
// created in a SEPARATE, explicitly-approved `pulumi up` (RECON decision 10).
//
// NOT represented here (stay unmanaged / direct-API, MUST NOT appear in state):
// walled garden (rest/portalconf), NetFlow IPFIX, traffic_flow, and the 2 auto
// IPS firewall rules. The provider has no resource we instantiate for them.
// (The abandoned `app--cp.worldwidewebb.co` hostname machinery — its A record and
// the guest portalHostname — was removed in Task 7 Step C; ADR-0006 dissolved the
// captive-portal product, so that host never went live.)

import * as pulumi from "@pulumi/pulumi";
import * as unifi from "@pulumiverse/unifi";

// ---------------------------------------------------------------------------
// Live resource identities (UniFi `_id`s from the RECON baseline dump,
// 2026-06-11, ~/cc-j934-unifi-baseline/). These are the `pulumi import` IDs.
// `_id`s are controller-internal handles, not secrets.
// ---------------------------------------------------------------------------
// Some resource types (dns.Record, setting.*) require the `site:id` import
// format; Network/Wlan/User accept the bare `_id`. The site on this controller
// is `default`. (Discovered at import time: the provider errors "ID does not
// contain site part" for the site-scoped types.)
const SITE = "default";
export const IMPORT_IDS = {
  defaultNetwork: "69334b751c01c943e7e9a93a",
  worldWideWebbWlan: "6934b503428b6c14e973b740",
  captivePortalDns: `${SITE}:6a293c1c37f85e778afb60a2`,
  guestAccess: `${SITE}:69334b751c01c943e7e9a928`,
} as const;

/**
 * @public - the UniFi provider, configured from env (the program wires these
 * from SOPS vault via env). apiKey auth against the local controller; allowInsecure for
 * the UCG self-signed cert. Consumed by the program; no internal consumer here.
 */
export function makeProvider(creds?: {
  apiUrl: string;
  apiKey: pulumi.Input<string>;
}): unifi.Provider {
  const apiUrl = creds?.apiUrl ?? requireEnv("UNIFI_API_URL");
  const apiKey = creds?.apiKey ?? pulumi.secret(requireEnv("UNIFI_API_KEY"));
  return new unifi.Provider(
    "unifi",
    {
      apiUrl,
      apiKey,
      // The UCG-Fiber serves the controller over a self-signed cert.
      allowInsecure: true,
      // Default site on this controller.
      site: "default",
    },
    // Pin the bridged-provider PLUGIN version to the SDK (@pulumiverse/unifi
    // 0.2.0) so a future `pulumi up` can't auto-pull a newer plugin that drifts
    // from the schema and forces state surgery (the v5/v6 footgun,
    // [[pulumi-cloudflare-v5-v6-import-pin]]). The bridged unifi provider is
    // especially prone to this. (www-j934.6 hardening.)
    { version: "0.2.0" },
  );
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} must be set (inject from SOPS vault via scripts/secrets.sh).`);
  }
  return v;
}

export interface AdoptedResources {
  defaultNetwork: unifi.Network;
  worldWideWebbWlan: unifi.Wlan;
  captivePortalDns: unifi.dns.Record;
  guestAccess: unifi.setting.GuestAccess;
  fixedIpUsers: unifi.iam.User[];
}

// Args common to every adopted resource: protect against deletion/replacement
// and never let an out-of-band drift on read-only/derived fields force a diff
// (adopt-only means we observe, we don't rewrite). `protect: true` makes a
// destroy a hard error, the structural guard behind Boundary 1.
function adoptOpts(
  provider: unifi.Provider,
  importId: string,
  ignoreChanges: string[] = [],
): pulumi.CustomResourceOptions {
  return {
    provider,
    protect: true,
    // The resource already exists; bind state to it rather than create.
    import: importId,
    ignoreChanges,
  };
}

/**
 * @public - declares the existing UniFi objects as adopted (imported, protected)
 * resources. Inputs mirror the live baseline so the post-import preview is
 * zero-diff. `fixedIpReservations` is the list of genuine DHCP reservations
 * (clients with `use_fixedip` true), passed in by the program from the baseline
 * manifest (mac is required to import a User; www-j934.3.1).
 */
export function adoptExisting(
  provider: unifi.Provider,
  fixedIpReservations: ReadonlyArray<{
    logicalName: string;
    importId: string;
    mac: string;
    name?: string;
  }>,
): AdoptedResources {
  // Default LAN: flat 192.168.0.0/24, no VLAN, DHCP on. purpose=corporate.
  const defaultNetwork = new unifi.Network(
    "default",
    {
      name: "Default",
      purpose: "corporate",
      subnet: "192.168.0.1/24",
      dhcpEnabled: true,
    },
    // The DHCP/IPv6 detail fields are controller-populated; adopt-only observes
    // them, never rewrites, so they must not manufacture a diff. (`unifi` is the
    // provider-internal passthrough block, always ignored on adopt.)
    adoptOpts(provider, IMPORT_IDS.defaultNetwork, [
      "dhcpStart",
      "dhcpStop",
      "dhcpV6Start",
      "dhcpV6Stop",
      "domainName",
      "ipv6PdStart",
      "ipv6PdStop",
      "ipv6RaEnable",
      "ipv6RaPriority",
      "ipv6RaValidLifetime",
      "multicastDns",
      "unifi",
    ]),
  );

  // world-wide-webb WLAN (wpapsk, not guest). passphrase is the live WiFi
  // password: NEVER declared here (no secret in repo) and ignored so adopt
  // can't try to rewrite it. BYTE-UNCHANGED is a Phase-5 assertion.
  const worldWideWebbWlan = new unifi.Wlan(
    "world-wide-webb",
    {
      name: "world-wide-webb",
      security: "wpapsk",
      networkId: defaultNetwork.id,
      // userGroupId is required by the schema; bound from live state via import.
      userGroupId: "",
    },
    adoptOpts(provider, IMPORT_IDS.worldWideWebbWlan, [
      "passphrase",
      "userGroupId",
      "apGroupIds",
      "pmfMode",
      "wpa3Support",
      "wpa3Transition",
      "unifi",
    ]),
  );

  // Static A record captive-portal.worldwidewebb.co -> 192.168.0.3 (split-horizon
  // LAN override; public DNS keeps the proxied CF wildcard). The www-guest VLAN
  // must resolve this too. Was 192.168.0.147 (the retired mini's LAN IP); it now
  // points at the home-server guest listener's MetalLB LoadBalancer IP, which
  // serves the captive portal on control-center-api (:80/:443).
  const captivePortalDns = new unifi.dns.Record(
    "captive-portal",
    {
      name: "captive-portal.worldwidewebb.co",
      value: "192.168.0.3",
      type: "A",
      enabled: true,
    },
    adoptOpts(provider, IMPORT_IDS.captivePortalDns),
  );

  // rsyslogd (gateway -> NAS 192.168.0.218:514, encrypted_only) is INTENTIONALLY
  // NOT managed here: @pulumiverse/unifi 0.2.0 cannot round-trip it on this
  // controller (Network 10.4.57). The controller stores `contents=null` when
  // logAllContents=true, but the provider's Check rejects enabled:true without a
  // non-empty `contents` array, so no declaration is both Check-valid AND
  // zero-diff. Managing it would require mutating the controller (violating
  // adopt-only Boundary 1). It joins the unmanaged/direct-API set with walled
  // garden + netflow + traffic_flow; Phase-5 verifies it byte-unchanged via a
  // direct controller GET vs the RECON baseline. Tracked upstream: www-2gpa.

  // guest_access: explicit live state captured from the controller (www-jtp0.5.9).
  // Fields are set in the Hotspot Portal console (www-q002.15); the provider
  // import + protect:true means Pulumi asserts they match (no write). Fields that
  // the bridged provider cannot round-trip cleanly are listed in ignoreChanges.
  // auth=custom: External Portal Server mode (NOT hotspot or none).
  // portalUseHostname=FALSE: Apple's Captive Network Assistant only renders the
  // captive sheet from a RAW-IP HTTP landing (http://192.168.0.3/...), NOT a
  // real domain (www-q002.26). www-jtp0.3.6 flipped this to a hostname and broke
  // real-device auth; www-p9hx reverts it. The guest redirect targets customIp
  // directly, so no portalHostname is declared (the abandoned app--cp hostname
  // was dropped in Task 7 Step C; ADR-0006 dissolved the captive-portal product).
  // ecEnabled=false: params arrive plaintext; the ec blob breaks the SPA.
  // expire=43200: 30-day session lifetime, matching authorize-guest (43200 min).
  // redirectToHttps and redirectUrl live in a nested redirect block on the provider.
  const guestAccess = new unifi.setting.GuestAccess(
    "guest-access",
    {
      auth: "custom",
      portalEnabled: true,
      portalUseHostname: false,
      // customIp: required by provider when auth=custom; the LAN IP that serves
      // the captive portal. With portalUseHostname=false the guest is redirected
      // here by raw IP over HTTP (the only thing Apple's CNA renders). Was the
      // mini's 192.168.0.147; now the home-server guest listener's MetalLB IP.
      customIp: "192.168.0.3",
      ecEnabled: false,
      expire: 43200,
    },
    adoptOpts(provider, IMPORT_IDS.guestAccess, ["unifi"]),
  );

  // Genuine DHCP fixed-IP reservations -> unifi.iam.User, adopt as-is. mac is the
  // required key for a User; fixedIp/networkId are controller state we don't
  // rewrite (ignoreChanges keeps adopt from manufacturing a diff on them).
  const fixedIpUsers = fixedIpReservations.map(
    (r) =>
      new unifi.iam.User(
        r.logicalName,
        {
          mac: r.mac,
          ...(r.name ? { name: r.name } : {}),
        },
        // allowExisting / skipForgetOnDestroy are provider-meta flags (computed
        // defaults, not UniFi config); localDnsRecord + fixedIp/networkId/note are
        // adopted controller state. Ignore all so adopt-only is a true no-op.
        adoptOpts(provider, r.importId, [
          "fixedIp",
          "networkId",
          "note",
          "name",
          "allowExisting",
          "skipForgetOnDestroy",
          "localDnsRecord",
          "unifi",
        ]),
      ),
  );

  return {
    defaultNetwork,
    worldWideWebbWlan,
    captivePortalDns,
    guestAccess,
    fixedIpUsers,
  };
}

export interface GuestVlanArgs {
  // VLAN id for the isolated guest network (unused on this flat LAN today).
  vlanId: number;
  // The guest subnet, a /24 distinct from 192.168.0.0/24 (e.g. 192.168.20.0/24).
  subnet: string;
  // DHCP range within the guest subnet.
  dhcpStart: string;
  dhcpStop: string;
  // The guest SSID name. www-guest is OPEN (no WPA), so no passphrase: access is
  // gated by the captive portal (guest_access external portal, www-q002.15), not
  // a wifi password (www-j934.3.2). `passphrase` is retained as optional only for
  // a future WPA variant; when absent the SSID is created with `security: open`.
  ssid: string;
  passphrase?: pulumi.Input<string>;
  // The portal host the guest VLAN is allowed to reach pre-auth (DESIGN §8).
  portalHost: string; // "192.168.0.3" (home-server guest LB; was mini .147)
  // First free index in the LAN-IN ruleset for the scoped allow rule.
  firewallRuleIndex: number;
}

export interface GuestVlanResources {
  network: unifi.Network;
  wlan: unifi.Wlan;
  portalAllowRule: unifi.firewall.Rule;
}

/**
 * @public - NEW, additive www-guest isolated VLAN + SSID (RECON decision 10).
 * Created ONLY when `unifi:applyGuest` is true, in a separate approved apply
 * (NOT during the adopt-only import). L2 isolation keeps guests off the LAN and
 * off each other; the single scoped cross-VLAN allowance to the portal host is
 * a firewall rule designed in DESIGN §8 (applied with the guest_access flip).
 */
export function createGuestVlan(provider: unifi.Provider, args: GuestVlanArgs): GuestVlanResources {
  const network = new unifi.Network(
    "www-guest",
    {
      name: "www-guest",
      // The UCG-Fiber does NOT honor a "guest" network purpose: it coerces it to
      // "corporate" on write, which makes the provider see a perpetual purpose
      // diff and try (and fail) to replace the network. Declare "corporate" to
      // match what the controller stores; guest behavior lives on the WLAN
      // (isGuest + l2Isolation) plus the isolation flag below (www-j934.3.2).
      purpose: "corporate",
      subnet: args.subnet,
      vlanId: args.vlanId,
      dhcpEnabled: true,
      dhcpStart: args.dhcpStart,
      dhcpStop: args.dhcpStop,
      // Network isolation: keeps the VLAN off the default LAN. The one permitted
      // cross-VLAN path (guest -> portal .147) is the scoped firewall rule below.
      networkIsolationEnabled: true,
      // The controller defaults a network's mDNS reflector to ON. Declare it to
      // match, otherwise the provider tries to remove it on every `pulumi up` and
      // the bridged Update call 404s ("not found"), wedging the stack (www-j934.3.2).
      multicastDns: true,
    },
    { provider },
  );

  // A WLAN must be assigned to an AP group or the controller rejects it with
  // `api.err.ApGroupMissing`. Look the default group ("All APs") up live via the
  // provider data source so no controller-internal id is hardcoded (www-j934.3.2).
  const defaultApGroup = unifi.getApGroupOutput({}, { provider });

  // OPEN by default (no passphrase) so guests join freely and the captive portal
  // gates them; a passphrase, if ever supplied, opts into WPA-PSK instead.
  const hasPassphrase = args.passphrase !== undefined;
  const wlan = new unifi.Wlan(
    "www-guest",
    {
      name: args.ssid,
      security: hasPassphrase ? "wpapsk" : "open",
      ...(hasPassphrase ? { passphrase: args.passphrase } : {}),
      apGroupIds: [defaultApGroup.id],
      networkId: network.id,
      // Guest policy on, plus explicit L2 client isolation so guests can't reach
      // EACH OTHER (not just the LAN); on an open SSID that matters (www-j934.3.2).
      isGuest: true,
      l2Isolation: true,
      userGroupId: "",
    },
    // The controller fills in its default user-group id, so our "" otherwise
    // churns a perpetual update; ignore it (same provider round-trip artifact).
    { provider, ignoreChanges: ["userGroupId"] },
  );

  // The SINGLE scoped cross-VLAN allowance (DESIGN §8): permit the guest VLAN to
  // reach ONLY the portal host on 80/443, so the captive-portal SPA + its
  // /api/trpc/portal.* calls load pre-auth. Everything else guest->LAN is
  // default-denied by the guest network's L2 isolation; this is the one hole.
  // (The walled-garden pre-auth allowance on rest/portalconf is applied
  // separately via direct-API, since it has no provider resource.)
  const portalAllowRule = new unifi.firewall.Rule(
    "www-guest-allow-portal",
    {
      name: "www-guest -> portal (.147) 80/443",
      enabled: true,
      ruleset: "LAN_IN",
      ruleIndex: args.firewallRuleIndex,
      action: "accept",
      protocol: "tcp",
      srcNetworkId: network.id,
      dstAddress: args.portalHost,
      dstPort: "80,443",
    },
    { provider },
  );

  return { network, wlan, portalAllowRule };
}
