import { describe, expect, it } from "vitest";
import { extensionHosts, TOOL_GROUPS, TOOLS, toolHost, toolsInGroup } from "@/registry";

describe("registry", () => {
  it("has no duplicate tool ids", () => {
    const ids = TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every tool a declared group", () => {
    for (const tool of TOOLS) {
      expect(TOOL_GROUPS).toContain(tool.group);
    }
  });

  it("gives every tool a parseable absolute https URL", () => {
    for (const tool of TOOLS) {
      const url = new URL(tool.url);
      expect(url.protocol, tool.id).toBe("https:");
      expect(toolHost(tool), tool.id).toBe(url.hostname);
    }
  });

  it("gives every tool a chip colour and a short letter mark", () => {
    for (const tool of TOOLS) {
      expect(tool.color, tool.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(tool.mark.length, tool.id).toBeLessThanOrEqual(2);
      expect(tool.mark.length, tool.id).toBeGreaterThan(0);
    }
  });

  it("places every tool in exactly one group's listing", () => {
    const grouped = TOOL_GROUPS.flatMap((group) => toolsInGroup(group));
    expect(grouped).toHaveLength(TOOLS.length);
    expect(new Set(grouped.map((tool) => tool.id)).size).toBe(TOOLS.length);
  });

  it("derives the extension allowlist from exactly the needsExtension tools", () => {
    const expected = [...new Set(TOOLS.filter((t) => t.needsExtension).map(toolHost))].sort();
    expect(extensionHosts()).toEqual(expected);
  });

  it("keeps hosts we control off the allowlist", () => {
    // The narrower the allowlist, the smaller the blast radius of an extension
    // that strips security headers. A host that frames fine on its own must
    // never be in it.
    const framable = TOOLS.filter((tool) => !tool.needsExtension).map(toolHost);
    expect(framable.length).toBeGreaterThan(0);
    for (const host of framable) {
      expect(extensionHosts()).not.toContain(host);
    }
  });

  it("does not list storybook — the workload was deleted, the pane would 502", () => {
    expect(TOOLS.map((tool) => tool.id)).not.toContain("storybook");
    expect(TOOLS.map(toolHost)).not.toContain("storybook.worldwidewebb.co");
  });
});
