/**
 * `apps:check` drift guard (Task 3.4). Regenerates the codegen aggregates
 * in-memory using the SAME collect() -> validate() -> renderTiles() pipeline as
 * `apps:gen` (scripts/apps-gen.ts), then diffs each render against the
 * committed `features/_generated/*.gen.ts` file. Exits non-zero on drift.
 *
 * Every committed aggregate, including the web runtime, must match a fresh
 * render of its App-owned source facets.
 *
 * THE BUN RUNTIME: same constraint as apps-gen.ts. collect() imports App
 * manifests and Tile View facets, which pull in the TSX tree using the `@/*` path
 * alias, resolvable only when bun's cwd is apps/web (it reads
 * apps/web/tsconfig.json's paths there). The `apps:check` package.json script
 * mirrors `apps:gen`'s `cd apps/web && bun run ...` pattern, so every path here
 * is resolved absolutely from the repo root via import.meta.url, never cwd.
 *
 * SCOPE: AGGREGATES covers every current feature aggregate plus the manage
 * extension allowlist artifacts. Keep this list in lockstep with apps:gen so a
 * new generated surface cannot land without an authoritative drift check.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderManifest, renderRules } from "../apps/manage/src/extension-rules";
import { GUEST_EXPOSED } from "../features/guest-exposed";
import { collect } from "./apps-gen/collect";
import {
  renderActivities,
  renderGuestRouter,
  renderHttp,
  renderJobs,
  renderRouter,
  renderSchedules,
  renderSchema,
  renderTiles,
  renderWeb,
  renderWorkflows,
} from "./apps-gen/emit";
import { validate } from "./apps-gen/validate";

// scripts/apps-check.ts -> repo root is one directory up from scripts/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GEN_DIR = join(REPO_ROOT, "features", "_generated");
const MANAGE_EXT_DIR = join(REPO_ROOT, "apps", "manage", "extension");

interface Aggregate {
  /** Path relative to `dir` (features/_generated/ by default), also the drift label. */
  file: string;
  /**
   * Absolute directory holding the committed artifact. Defaults to
   * features/_generated/; the manage extension's generated files live under
   * apps/manage/extension/ instead, since Chrome dictates their filenames.
   */
  dir?: string;
  render: () => Promise<string>;
}

const AGGREGATES: readonly Aggregate[] = [
  {
    file: "tiles.gen.ts",
    render: async () => {
      const model = await collect();
      validate(model, GUEST_EXPOSED);
      return renderTiles(model);
    },
  },
  {
    file: "web.gen.ts",
    render: async () => renderWeb(await collect()),
  },
  {
    file: "router.gen.ts",
    render: async () => renderRouter(await collect()),
  },
  {
    file: "guest-router.gen.ts",
    render: async () => renderGuestRouter(await collect(), GUEST_EXPOSED),
  },
  {
    file: "schema.gen.ts",
    render: async () => renderSchema(await collect()),
  },
  // Backfill (issue #260): these predate this entry but were never
  // drift-checked — the natural mistake is emitting in apps-gen.ts and
  // forgetting this list.
  {
    file: "jobs.gen.ts",
    render: async () => renderJobs(await collect()),
  },
  {
    file: "http.gen.ts",
    render: async () => renderHttp(await collect()),
  },
  // Temporal facet artifacts (ADR-0008).
  {
    file: "workflows.gen.ts",
    render: async () => renderWorkflows(await collect()),
  },
  {
    file: "activities.gen.ts",
    render: async () => renderActivities(await collect()),
  },
  {
    file: "schedules.gen.ts",
    render: async () => renderSchedules(await collect()),
  },
  // manage's browser-extension allowlist (ADR-0010). Drift here means a tool is
  // in the sidebar but not in the extension's allowlist — a pane that renders
  // blank with nothing in any log, which is exactly the bug class this check
  // exists to turn into a build failure.
  {
    file: "rules.gen.json",
    dir: MANAGE_EXT_DIR,
    render: async () => renderRules(),
  },
  {
    file: "manifest.json",
    dir: MANAGE_EXT_DIR,
    render: async () => renderManifest(),
  },
];

/** @public consumed by test/scripts/apps-check.test.ts and this module's CLI wrapper. */
export async function checkDrift(): Promise<{ drifted: boolean; files: string[] }> {
  const drifted: string[] = [];
  for (const aggregate of AGGREGATES) {
    const fresh = await aggregate.render();
    const committedPath = join(aggregate.dir ?? GEN_DIR, aggregate.file);
    let committed: string;
    try {
      committed = readFileSync(committedPath, "utf8");
    } catch {
      drifted.push(relative(REPO_ROOT, committedPath));
      continue;
    }
    if (committed !== fresh) {
      drifted.push(relative(REPO_ROOT, committedPath));
    }
  }
  return { drifted: drifted.length > 0, files: drifted };
}

async function main(): Promise<void> {
  const result = await checkDrift();
  if (result.drifted) {
    console.error("apps:check: drift detected in generated files:");
    for (const file of result.files) {
      console.error(`  - ${file}`);
    }
    console.error("\nRun `bun run apps:gen` to regenerate, then commit the result.");
    process.exit(1);
  }
  console.log("apps:check: clean — features/_generated/* matches a fresh apps:gen render.");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
