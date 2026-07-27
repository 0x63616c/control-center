/**
 * `apps:check` drift guard (Task 3.4). Regenerates the codegen aggregates
 * in-memory using the SAME collect() -> validate() -> renderTiles() pipeline as
 * `apps:gen` (scripts/apps-gen.ts), then diffs each render against the
 * committed `features/_generated/*.gen.ts` file. Exits non-zero on drift.
 *
 * This closes the gap the 3.3 reviewer flagged: nothing previously asserted
 * that the committed tiles.gen.ts matches a fresh render of its source
 * (TILE_REGISTRY this slice; the per-feature manifests join in Slice 5).
 *
 * THE BUN RUNTIME: same constraint as apps-gen.ts. collect() imports apps/web's
 * TILE_REGISTRY, which pulls in ~40 tile TSX components using the `@/*` path
 * alias, resolvable only when bun's cwd is apps/web (it reads
 * apps/web/tsconfig.json's paths there). The `apps:check` package.json script
 * mirrors `apps:gen`'s `cd apps/web && bun run ...` pattern, so every path here
 * is resolved absolutely from the repo root via import.meta.url, never cwd.
 *
 * SCOPE: this slice only has `tiles.gen.ts` under features/_generated/ (the
 * router/guest-router/schema/crons gen files are deferred to Slice 5). AGGREGATES
 * below lists just that one file so Slice 5 can extend the checked set by
 * appending entries, not restructuring this module.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GUEST_EXPOSED } from "../features/guest-exposed";
import { collect } from "./apps-gen/collect";
import {
  renderActivities,
  renderCronHandlers,
  renderCrons,
  renderGuestRouter,
  renderHttp,
  renderJobs,
  renderRouter,
  renderSchedules,
  renderSchema,
  renderTiles,
  renderWorkflows,
} from "./apps-gen/emit";
import { validate } from "./apps-gen/validate";

// scripts/apps-check.ts -> repo root is one directory up from scripts/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GEN_DIR = join(REPO_ROOT, "features", "_generated");

interface Aggregate {
  /** Path relative to features/_generated/, also used as the drift report label. */
  file: string;
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
  {
    file: "crons.gen.ts",
    render: async () => renderCrons(await collect()),
  },
  // Backfill (issue #260): these three predate this entry but were never
  // drift-checked — the natural mistake is emitting in apps-gen.ts and
  // forgetting this list.
  {
    file: "cron-handlers.gen.ts",
    render: async () => renderCronHandlers(await collect()),
  },
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
];

/** @public consumed by scripts/apps-check.test.ts and this module's CLI wrapper. */
export async function checkDrift(): Promise<{ drifted: boolean; files: string[] }> {
  const drifted: string[] = [];
  for (const aggregate of AGGREGATES) {
    const fresh = await aggregate.render();
    const committedPath = join(GEN_DIR, aggregate.file);
    let committed: string;
    try {
      committed = readFileSync(committedPath, "utf8");
    } catch {
      drifted.push(aggregate.file);
      continue;
    }
    if (committed !== fresh) {
      drifted.push(aggregate.file);
    }
  }
  return { drifted: drifted.length > 0, files: drifted };
}

async function main(): Promise<void> {
  const result = await checkDrift();
  if (result.drifted) {
    console.error("apps:check: drift detected in generated files:");
    for (const file of result.files) {
      console.error(`  - features/_generated/${file}`);
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
