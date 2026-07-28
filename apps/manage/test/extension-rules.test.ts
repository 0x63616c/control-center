import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTENSION_VERSION, MANAGE_ORIGINS, renderManifest, renderRules } from "@/extension-rules";
import { extensionHosts, TOOLS, toolHost } from "@/registry";

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");

function readExt(file: string): unknown {
  return JSON.parse(readFileSync(join(EXT_DIR, file), "utf8"));
}

interface Rule {
  action: { type: string; responseHeaders: { header: string; operation: string }[] };
  condition: { requestDomains: string[]; resourceTypes: string[] };
}

const rules = readExt("rules.gen.json") as Rule[];
const manifest = readExt("manifest.json") as {
  manifest_version: number;
  version: string;
  host_permissions: string[];
  permissions: string[];
  content_scripts: { matches: string[]; js: string[]; run_at: string }[];
  declarative_net_request: { rule_resources: { path: string; enabled: boolean }[] };
};

describe("generated extension rules", () => {
  it("matches a fresh render of the registry (same guard as apps:check)", () => {
    expect(readFileSync(join(EXT_DIR, "rules.gen.json"), "utf8")).toBe(renderRules());
    expect(readFileSync(join(EXT_DIR, "manifest.json"), "utf8")).toBe(renderManifest());
  });

  it("applies to framed sub-documents ONLY", () => {
    // The single most important assertion in this file. Without the sub_frame
    // restriction the extension strips security headers from top-level
    // navigation too — i.e. across the operator's whole browsing session.
    for (const rule of rules) {
      expect(rule.condition.resourceTypes).toEqual(["sub_frame"]);
    }
  });

  it("never uses a wildcard allowlist", () => {
    for (const rule of rules) {
      expect(rule.condition.requestDomains.length).toBeGreaterThan(0);
      for (const domain of rule.condition.requestDomains) {
        expect(domain).not.toContain("*");
      }
    }
    for (const pattern of manifest.host_permissions) {
      expect(pattern).not.toBe("<all_urls>");
      expect(pattern).toMatch(/^https:\/\/[^*]+\/\*$/);
    }
  });

  it("covers every tool that needs the extension, and nothing else", () => {
    const domains = rules.flatMap((rule) => rule.condition.requestDomains).sort();
    expect(domains).toEqual([...extensionHosts()]);

    for (const tool of TOOLS) {
      expect(domains.includes(toolHost(tool)), `${tool.id} allowlisted`).toBe(tool.needsExtension);
    }
  });

  it("removes the headers that refuse framing", () => {
    for (const rule of rules) {
      expect(rule.action.type).toBe("modifyHeaders");
      const removed = rule.action.responseHeaders
        .filter((header) => header.operation === "remove")
        .map((header) => header.header);
      expect(removed).toContain("x-frame-options");
      expect(removed).toContain("content-security-policy");
    }
  });

  it("declares an MV3 manifest wired to the generated rule file", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe(EXTENSION_VERSION);
    expect(manifest.permissions).toEqual(["declarativeNetRequest"]);
    expect(manifest.declarative_net_request.rule_resources).toEqual([
      { id: "manage-frame-unlock", enabled: true, path: "rules.gen.json" },
    ]);
  });

  it("host_permissions cover exactly the rule's domains", () => {
    // Chrome will not apply modifyHeaders to a request the extension has no
    // host permission for, so a rule domain missing here is a silently dead rule.
    expect(manifest.host_permissions.sort()).toEqual(
      extensionHosts()
        .map((host) => `https://${host}/*`)
        .sort(),
    );
  });

  it("runs the flag-stamping content script on manage itself, at document_start", () => {
    const [script] = manifest.content_scripts;
    expect(script.matches).toEqual(MANAGE_ORIGINS);
    expect(script.js).toEqual(["content.js"]);
    // Later than document_start and React's first render reads no flag, so
    // manage paints launcher cards for a frame before correcting itself.
    expect(script.run_at).toBe("document_start");
    // Local dev must exercise the same detection path as prod.
    expect(script.matches).toContain("http://localhost/*");
    expect(script.matches).toContain("https://manage.worldwidewebb.co/*");
  });
});
