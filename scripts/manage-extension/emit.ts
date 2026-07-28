/**
 * Renders the manage browser extension's two generated files from
 * apps/manage/src/registry.ts.
 *
 * WHY GENERATED (ADR-0002's committed-codegen pattern, ADR-0010's one
 * non-negotiable safety rail): the extension only strips `x-frame-options` /
 * `content-security-policy` for hosts on an explicit allowlist. Hand-maintained,
 * that allowlist silently rots — someone adds a tool to the sidebar, forgets the
 * extension, and the pane renders blank with no error anywhere. Generated and
 * drift-checked by `bun run apps:check`, the same mistake fails the build.
 *
 * Two invariants are encoded here rather than left to a reviewer:
 *
 *  1. `resourceTypes: ["sub_frame"]` — the rule must apply ONLY to framed
 *     documents. Without it the extension strips security headers from
 *     top-level navigations too, i.e. across the operator's entire browsing
 *     session, for the sake of a sidebar.
 *  2. The allowlist is enumerated hosts, NEVER `<all_urls>` / a wildcard. Same
 *     reason: the blast radius of this extension is exactly the hosts named in
 *     this file, and that is the property that made a local extension
 *     preferable to a Cloudflare transform rule at the edge.
 */
import { extensionHosts } from "../../apps/manage/src/registry";

/** Bumped by hand; the content script reports it as manage's "extension active" version. */
export const EXTENSION_VERSION = "1.0.0";

/** Origins the content script runs on — i.e. where manage itself is served. */
export const MANAGE_ORIGINS = [
  "https://manage.worldwidewebb.co/*",
  // Local dev (`bun run --cwd apps/manage dev`) must detect the extension the
  // same way prod does, or the local run everyone reviews from is a different
  // code path than the one that ships.
  "http://localhost/*",
  "http://127.0.0.1/*",
];

function hostPatterns(hosts: readonly string[]): string[] {
  return hosts.map((host) => `https://${host}/*`);
}

/** apps/manage/extension/rules.gen.json */
export function renderRules(): string {
  const hosts = extensionHosts();
  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "x-frame-options", operation: "remove" },
          { header: "content-security-policy", operation: "remove" },
          // Report-only would not block the frame, but Chrome still reports a
          // violation for every subresource; removing it keeps the console of a
          // framed tool usable for real debugging.
          { header: "content-security-policy-report-only", operation: "remove" },
        ],
      },
      condition: {
        requestDomains: [...hosts],
        // NON-NEGOTIABLE. See the module comment.
        resourceTypes: ["sub_frame"],
      },
    },
  ];
  return `${JSON.stringify(rules, null, 2)}\n`;
}

/** apps/manage/extension/manifest.json */
export function renderManifest(): string {
  const hosts = extensionHosts();
  const manifest = {
    manifest_version: 3,
    name: "manage — frame unlock",
    version: EXTENSION_VERSION,
    description:
      "Strips frame-deny response headers from manage's tool allowlist, for framed sub-documents only.",
    permissions: ["declarativeNetRequest"],
    host_permissions: hostPatterns(hosts),
    declarative_net_request: {
      rule_resources: [
        {
          id: "manage-frame-unlock",
          enabled: true,
          path: "rules.gen.json",
        },
      ],
    },
    content_scripts: [
      {
        matches: MANAGE_ORIGINS,
        js: ["content.js"],
        // document_start so the flag is on <html> before React's first render
        // reads it — otherwise manage paints launcher cards for one frame.
        run_at: "document_start",
      },
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
