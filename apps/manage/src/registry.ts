/**
 * The registry IS manage. Data only, no branches.
 *
 * Every difference between two tools — where it lives, what colour its chip is,
 * whether framing it needs the header-stripping extension — is a field here, not
 * a code path. That is the whole design bet of ADR-0010: one mechanism, and all
 * the variance in a table. Adding a tool must never mean adding an `if`.
 *
 * The extension's rule file is GENERATED from this table
 * (apps/manage/src/extension-rules.ts, checked by `bun run apps:check`), so
 * "added a tool, forgot the allowlist" is a build failure rather than a pane
 * that mysteriously renders blank months later.
 */

/** Sidebar sections, in render order. The order of this array is the UI order. */
export const TOOL_GROUPS = ["House", "Platform", "Infra", "Network", "Code"] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

export interface Tool {
  /** Stable slug; the selected tool is keyed by this. */
  id: string;
  label: string;
  url: string;
  /** Logo chip background. */
  color: string;
  /** 1–2 character letter mark shown in the chip. */
  mark: string;
  group: ToolGroup;
  /**
   * True when the origin refuses framing (`x-frame-options`, or a CSP
   * `frame-ancestors`) and only renders as a pane once the local MV3 extension
   * has stripped those response headers.
   *
   * False ONLY where we control the response and it carries no frame-deny —
   * today that is the control-center and Software Factory nginx origins.
   * Everything else is third-party or upstream-configured, so it is marked true
   * and lands in the generated allowlist. Marking a framable host `true` costs
   * nothing but an extra allowlist entry; marking a frame-denying host `false`
   * ships a pane that is permanently blank, so the asymmetry is deliberate.
   */
  needsExtension: boolean;
}

export const TOOLS: readonly Tool[] = [
  // ── House ────────────────────────────────────────────────────────────────
  {
    id: "cc",
    label: "Control Center",
    url: "https://app.worldwidewebb.co",
    color: "#0070f3",
    mark: "CC",
    group: "House",
    // Our own nginx (apps/web/nginx.conf) sets no frame-deny header.
    needsExtension: false,
  },
  {
    id: "ha",
    label: "Home Assistant",
    url: "https://ha.worldwidewebb.co",
    color: "#41bdf5",
    mark: "HA",
    group: "House",
    needsExtension: true,
  },
  {
    id: "plex",
    label: "Plex",
    url: "https://app.plex.tv/desktop",
    color: "#e5a00d",
    mark: "PX",
    group: "House",
    needsExtension: true,
  },

  // ── Platform ─────────────────────────────────────────────────────────────
  {
    id: "grafana",
    label: "Grafana",
    url: "https://grafana.worldwidewebb.co",
    color: "#f46800",
    mark: "G",
    group: "Platform",
    needsExtension: true,
  },
  {
    id: "temporal",
    label: "Temporal",
    url: "https://temporal-ui.worldwidewebb.co",
    color: "#7c3aed",
    mark: "T",
    group: "Platform",
    needsExtension: true,
  },
  {
    id: "pgadmin",
    label: "pgAdmin",
    url: "https://db-ui.worldwidewebb.co",
    color: "#336791",
    mark: "PG",
    group: "Platform",
    needsExtension: true,
  },
  // NB: Storybook is deliberately absent. The control-center-storybook workload
  // was deleted in Track B (infra/src/services.ts) and its tunnel route pruned
  // (infra/cloudflare/src/routes.ts) — storybook is a local-dev-only tool now,
  // so a `storybook.worldwidewebb.co` row would be a pane that always 502s.

  // ── Infra ────────────────────────────────────────────────────────────────
  {
    id: "cloudflare",
    label: "Cloudflare",
    url: "https://dash.cloudflare.com",
    color: "#f6821f",
    mark: "CF",
    group: "Infra",
    needsExtension: true,
  },
  {
    id: "zero-trust",
    label: "Zero Trust",
    url: "https://one.dash.cloudflare.com",
    color: "#b45309",
    mark: "ZT",
    group: "Infra",
    needsExtension: true,
  },
  {
    id: "pulumi",
    label: "Pulumi",
    url: "https://app.pulumi.com",
    color: "#8a3391",
    mark: "PU",
    group: "Infra",
    needsExtension: true,
  },
  {
    id: "tailscale",
    label: "Tailscale",
    url: "https://login.tailscale.com/admin",
    color: "#4b5563",
    mark: "TS",
    group: "Infra",
    needsExtension: true,
  },

  // ── Network ──────────────────────────────────────────────────────────────
  {
    id: "unifi",
    label: "UniFi",
    url: "https://unifi.worldwidewebb.co",
    color: "#1c6fd6",
    mark: "U",
    group: "Network",
    // Verified live: https://192.168.0.1 → x-frame-options: SAMEORIGIN.
    needsExtension: true,
  },
  {
    id: "synology",
    label: "Synology",
    url: "https://dsm.worldwidewebb.co",
    color: "#88c04f",
    mark: "DS",
    group: "Network",
    // Verified live: https://192.168.0.218:5001 → x-frame-options: SAMEORIGIN
    // plus a CSP. (.218 — .219 is a long-running mis-transcription in this repo.)
    needsExtension: true,
  },

  // ── Code ─────────────────────────────────────────────────────────────────
  {
    id: "factory",
    label: "Software Factory",
    url: "https://factory.worldwidewebb.co",
    color: "#6366f1",
    mark: "SF",
    group: "Code",
    // Our own nginx (apps/software-factory/web/nginx.conf) sets no frame-deny header.
    needsExtension: false,
  },
  {
    id: "github",
    label: "GitHub",
    url: "https://github.com/0x63616c/world-wide-webb",
    color: "#6e7681",
    mark: "GH",
    group: "Code",
    // x-frame-options: deny AND `content-security-policy: default-src 'none'`.
    // Framed anyway rather than launched: keeping the frame on github.com means
    // the origin stays github.com, so the passkey login still works (the pane's
    // `allow="publickey-credentials-get"` delegates it).
    needsExtension: true,
  },
];

/** The tools of one group, in registry order. */
export function toolsInGroup(group: ToolGroup): readonly Tool[] {
  return TOOLS.filter((tool) => tool.group === group);
}

/** Hostname of a tool's URL — the unit the extension allowlist is keyed on. */
export function toolHost(tool: Tool): string {
  return new URL(tool.url).hostname;
}

/**
 * Hosts the extension must strip frame-deny headers for: exactly the
 * `needsExtension` tools, deduplicated, sorted for a stable generated file.
 * Never a wildcard — see apps/manage/src/extension-rules.ts.
 */
export function extensionHosts(): readonly string[] {
  return [...new Set(TOOLS.filter((tool) => tool.needsExtension).map(toolHost))].sort();
}
