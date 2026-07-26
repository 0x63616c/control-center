// Pulumi program for the control-center-unifi project (www-j934.3).
//
// ADOPT-ONLY import of the live UCG-Fiber config (GOAL.md Boundary 1): declares
// the existing Network / WLAN / DNS / fixed-IP Users / rsyslogd /
// guest_access as imported, protected resources. The first `pulumi preview`
// after import MUST be zero-diff before ANY apply.
//
// The DHCP reservations carry client MACs (network internals), so they are
// NOT committed to this public repo: the program reads them at apply time from
// a local manifest (default: ~/cc-j934-unifi-baseline/fixed-ip-manifest.json,
// override with UNIFI_FIXED_IP_MANIFEST). The manifest holds ONLY genuine
// `use_fixedip` reservations (derived via scripts/gen-fixed-ip-manifest.ts, the
// single source of truth; www-j934.3.1). The provider creds come from env,
// sourced from SOPS vault via env (never printed, never committed):
//   UNIFI_API_URL  = UNIFI__CONTROLLER_URL  (https://192.168.0.1)
//   UNIFI_API_KEY  = UNIFI__LOCAL_API_KEY
//
// The www-guest VLAN/SSID is additive and gated behind `unifi:applyGuest`
// (default false), so the import-only phase declares only adopted resources.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import type { FixedIpReservation } from "./src/manifest.ts";
import { adoptExisting, createGuestVlan, createLanDnsRecord, makeProvider } from "./src/unifi.ts";

function loadFixedIpReservations(): FixedIpReservation[] {
  const path =
    process.env.UNIFI_FIXED_IP_MANIFEST ??
    join(homedir(), "cc-j934-unifi-baseline", "fixed-ip-manifest.json");
  const raw = readFileSync(path, "utf8");
  const entries = JSON.parse(raw) as FixedIpReservation[];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`fixed-IP manifest at ${path} is empty or malformed`);
  }
  return entries;
}

const provider = makeProvider();
const reservations = loadFixedIpReservations();

const cfg = new pulumi.Config("ccunifi");

const adopted = adoptExisting(provider, reservations);

// www-guest VLAN/SSID: NEW, additive, applied ONLY when explicitly enabled in
// a separate approved `pulumi up` (NOT during adopt-only import). Guarded so the
// import preview stays zero-diff.
// NOT the `unifi:` namespace, that belongs to the provider, and Pulumi would
// try to pass these keys to it ("not a valid configuration key"). Use a project
// namespace for our own flags.
if (cfg.getBoolean("applyGuest")) {
  const guest = createGuestVlan(provider, {
    vlanId: cfg.requireNumber("guestVlanId"),
    subnet: cfg.require("guestSubnet"),
    dhcpStart: cfg.require("guestDhcpStart"),
    dhcpStop: cfg.require("guestDhcpStop"),
    ssid: cfg.get("guestSsid") ?? "www-guest",
    // OPEN network: no passphrase (www-j934.3.2). `guestPassphrase` is optional:
    // set it only to opt into WPA-PSK instead; unset => an open, portal-gated SSID.
    passphrase: cfg.getSecret("guestPassphrase"),
    // The portal host the guest VLAN may reach pre-auth (split-horizon DNS
    // resolves captive-portal.worldwidewebb.co to this for guest clients too).
    // The home-server guest listener's MetalLB LB IP; was the retired mini's .147.
    portalHost: cfg.get("portalHost") ?? "192.168.0.3",
    // LAN_IN user-rule index. The UCG-Fiber uses a 5-digit range (its IPS rules
    // sit at 20000/20001); 2000 is rejected as out-of-range, so default into the
    // valid window above the IPS rules (www-j934.3.2).
    firewallRuleIndex: cfg.getNumber("firewallRuleIndex") ?? 22000,
  });
  exportGuest(guest);
}

function exportGuest(guest: ReturnType<typeof createGuestVlan>): void {
  // Surface the new network/wlan ids only (no secret).
  pulumi.all([guest.network.id, guest.wlan.id]).apply(([net, wlan]) => {
    pulumi.log.info(`www-guest network=${net} wlan=${wlan}`);
  });
}

// LAN-only local DNS record for Home Assistant (#75: Calum picked "B" — a
// UniFi Local DNS Record over a public Cloudflare Tunnel route, since HA
// controls physical devices in the house and there's no live need to reach
// its UI off-LAN today). Gated behind `unifi:applyHaDns` (default false) so
// this stays additive-only until Calum explicitly approves the apply, same
// pattern as `applyGuest` above. Resolves to the home-server Talos node
// (192.168.0.5, DEFAULT_TALOS_NODE_IP in infra/src/services.ts) — HA runs
// in-cluster there; see infra/src/services.ts `haTarget()`.
if (cfg.getBoolean("applyHaDns")) {
  const haDns = createLanDnsRecord(provider, {
    hostname: cfg.get("haHostname") ?? "ha.worldwidewebb.co",
    target: cfg.get("haTarget") ?? "192.168.0.5",
  });
  exportHaDns(haDns);
}

function exportHaDns(record: ReturnType<typeof createLanDnsRecord>): void {
  pulumi.all([record.name, record.value]).apply(([name, value]) => {
    pulumi.log.info(`ha local DNS record ${name} -> ${value}`);
  });
}

// Export the adopted resource ids (not values) for the byte-unchanged Phase-5
// cross-check and for downstream references.
export const defaultNetworkId = adopted.defaultNetwork.id;
export const worldWideWebbWlanId = adopted.worldWideWebbWlan.id;
export const captivePortalDnsId = adopted.captivePortalDns.id;
export const fixedIpUserCount = adopted.fixedIpUsers.length;
