// Guest bundle isolation contract (SDD track 0, task 2.3).
//
// The guest portal entry (src/portal/main.tsx) is a SEPARATE Vite build
// (vite.portal.config.ts -> dist-portal/) from the panel app (vite.config.ts
// -> dist/). Guests connect over an open, unauthenticated captive-portal
// network path, so the guest bundle must never ship panel-only code: the
// board renderer, the tile registry (which enumerates every integration this
// household has), the map tiles library, or the panel settings store.
//
// This test statically walks the ES-module import graph starting at
// src/portal/main.tsx (following relative + "@/" aliased imports, and
// recording bare package specifiers without resolving into node_modules) and
// asserts the graph never reaches the banned modules. It mirrors the
// import-graph documentation approach of
// products/captive-portal/apps/api/src/cc-coupling-boundary.test.ts, adapted
// from "declare a fixed dependency list" to "walk the real graph", since here
// the binding requirement is a NEGATIVE guarantee (these must never appear)
// rather than a positive declared coupling.
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = resolve(__dirname, "../..");
const ENTRY = resolve(SRC_DIR, "portal/main.tsx");

const RESOLVABLE_EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js"];
const INDEX_SUFFIXES = ["/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

// Matches: `import ... from "spec"`, `export ... from "spec"`, bare
// `import "spec"`, and dynamic `import("spec")`.
// NOTE: This regex only matches STRING-LITERAL import specifiers. It cannot detect
// non-literal dynamic imports like `import(variable)` or `import(\`path/\${expr}\`)`.
// See the "portal sources use only string-literal import specifiers (walker soundness)"
// test for a companion soundness check that guards against this regex limitation.
const IMPORT_SPECIFIER_RE =
  /(?:import|export)(?:[^'";]*?from\s*)?\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) specifiers.push(spec);
  }
  return specifiers;
}

function resolveInternal(specifier: string, importerFile: string): string | null {
  let base: string;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(importerFile), specifier);
  } else if (specifier.startsWith("@/")) {
    base = resolve(SRC_DIR, specifier.slice(2));
  } else {
    return null; // bare package specifier — not part of our source tree
  }

  if (extname(base) && existsSync(base)) return base;

  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  for (const suffix of INDEX_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface ImportGraph {
  internalFiles: Set<string>;
  externalPackages: Set<string>;
}

function walkImportGraph(entry: string): ImportGraph {
  const internalFiles = new Set<string>();
  const externalPackages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || internalFiles.has(file)) continue;
    internalFiles.add(file);

    const source = readFileSync(file, "utf-8");
    for (const specifier of extractSpecifiers(source)) {
      const resolved = resolveInternal(specifier, file);
      if (resolved) {
        if (!internalFiles.has(resolved)) queue.push(resolved);
      } else if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
        externalPackages.add(specifier);
      }
    }
  }

  return { internalFiles, externalPackages };
}

describe("guest bundle isolation (src/portal/main.tsx import graph)", () => {
  const graph = walkImportGraph(ENTRY);

  it("walked more than just the entry file (sanity check the graph walker works)", () => {
    expect(graph.internalFiles.size).toBeGreaterThan(1);
  });

  it("never imports the panel board renderer", () => {
    const hit = [...graph.internalFiles].find((f) => f.includes("/components/Board"));
    expect(hit).toBeUndefined();
  });

  it("never imports the tile registry", () => {
    const hit = [...graph.internalFiles].find((f) => f.includes("/_generated/web.gen"));
    expect(hit).toBeUndefined();
  });

  it("never imports maplibre-gl", () => {
    expect(graph.externalPackages.has("maplibre-gl")).toBe(false);
  });

  it("never imports the panel settings store", () => {
    const hit = [...graph.internalFiles].find((f) => f.includes("/lib/settings"));
    expect(hit).toBeUndefined();
  });

  it("portal sources use only string-literal import specifiers (walker soundness)", () => {
    // Detection runs against the WHOLE source string (not a per-line split):
    // `\s` already matches newlines, so these patterns span multi-line dynamic
    // imports like `import(\n  someVar\n)`. A per-line split would sever
    // `import(` from its argument on the next line and silently miss it.
    const NON_LITERAL_DYNAMIC_IMPORT_RES = [
      /import\s*\(\s*[^'"` \n]/g,
      /import\s*\(\s*\{/g,
      /import\s*\(\s*\(/g,
      /import\s*\(\s*`[^`]*\$\{/g,
    ];

    function findNonLiteralDynamicImports(
      source: string,
    ): Array<{ index: number; context: string }> {
      const hits: Array<{ index: number; context: string }> = [];
      for (const re of NON_LITERAL_DYNAMIC_IMPORT_RES) {
        for (const match of source.matchAll(re)) {
          const index = match.index ?? 0;
          hits.push({ index, context: source.slice(index, index + 40).replace(/\n/g, "\\n") });
        }
      }
      return hits;
    }

    function lineNumberAt(source: string, index: number): number {
      let line = 1;
      for (let i = 0; i < index && i < source.length; i++) {
        if (source[i] === "\n") line++;
      }
      return line;
    }

    // Sanity check: verify detection works on inline fixtures, including
    // multi-line dynamic imports (the bug this test guards against).
    const nonLiteralPatterns = [
      "import(myVar)",
      "import( variable )",
      "import({ a })",
      "import(( expr ))",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test payload
      "import(`path/${name}`)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test payload
      "import(`template/${x}`)",
      "import(\n  someVar\n)",
    ];
    for (const pattern of nonLiteralPatterns) {
      expect(findNonLiteralDynamicImports(pattern).length).toBeGreaterThan(0);
    }

    // These patterns should pass (literal imports are OK), including a
    // multi-line literal (must NOT be flagged just because it spans lines):
    const literalPatterns = [
      'import("literal")',
      "import('literal')",
      "import(`template-literal`)",
      "import(\n  './ok'\n)",
    ];
    for (const pattern of literalPatterns) {
      expect(findNonLiteralDynamicImports(pattern)).toEqual([]);
    }
    // NOTE: comments containing `import(...)` (e.g. `// import(x)`) are not
    // stripped before scanning, so a non-literal dynamic import mentioned only
    // in a comment would be (falsely) flagged. This is intentionally
    // conservative rather than risking a false negative from a broken
    // comment-stripper; no such comment exists in portal sources today.

    // Now check all walked portal source files for non-literal dynamic imports.
    const violations: Array<{ file: string; line: number; context: string }> = [];

    for (const file of graph.internalFiles) {
      if (!file.includes("/portal/")) continue;

      const source = readFileSync(file, "utf-8");
      for (const hit of findNonLiteralDynamicImports(source)) {
        violations.push({
          file: file.replace(SRC_DIR, ""),
          line: lineNumberAt(source, hit.index),
          context: hit.context,
        });
      }
    }

    expect(violations).toEqual([]);
  });
});
