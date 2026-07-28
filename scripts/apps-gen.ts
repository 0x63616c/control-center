/**
 * `apps:gen` entrypoint (Task 3.3). Collects the app model, validates it as one
 * consistent whole, emits the committed `features/_generated/*.gen.ts`, and
 * biome-formats the output. This slice is a byte-identical no-op: the generated
 * module is a typed projection of the SAME data the runtime already reads from
 * TILE_REGISTRY, so the app keeps consuming the registry directly and nothing
 * imports the generated file yet.
 *
 * THE BUN RUNTIME: `collect()` imports apps/web's TILE_REGISTRY, which pulls in
 * ~40 tile TSX components that use the `@/*` path alias. Bare `bun` at the repo
 * root has no `@/*` mapping (root tsconfig defines none), so this script MUST be
 * run with cwd = apps/web, where bun natively reads apps/web/tsconfig.json's
 * `@/*` -> ./src/* mapping. The `apps:gen` package.json script does that
 * (`cd apps/web && bun run ../../scripts/apps-gen.ts`). Because cwd is then
 * apps/web, every path below is resolved absolutely from the repo root (derived
 * from import.meta.url), never from cwd.
 *
 * FORMATTING: no biome pass runs here. biome.json globally ignores gen files
 * (the `!**` + `.gen.ts` include-negation — generated artifacts are opaque to
 * lint/format), so a `biome format` on the
 * output is a no-op that also errors ("no files processed"). The emitter instead
 * produces canonical, already-formatted output directly (scripts/apps-gen/emit.ts),
 * which is what makes two runs byte-identical.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  renderWorkflows,
} from "./apps-gen/emit";
import { validate } from "./apps-gen/validate";
import { renderManifest, renderRules } from "./manage-extension/emit";

// scripts/apps-gen.ts -> repo root is one directory up from scripts/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GEN_DIR = join(REPO_ROOT, "features", "_generated");
// The manage browser extension's allowlist is generated from apps/manage's
// registry for the same reason the feature aggregates are: a hand-maintained
// copy of a list that lives somewhere else rots silently (ADR-0010).
const MANAGE_EXT_DIR = join(REPO_ROOT, "apps", "manage", "extension");

async function main(): Promise<void> {
  const model = await collect();
  validate(model, GUEST_EXPOSED);
  writeFileSync(join(GEN_DIR, "tiles.gen.ts"), renderTiles(model));
  writeFileSync(join(GEN_DIR, "router.gen.ts"), renderRouter(model));
  writeFileSync(join(GEN_DIR, "guest-router.gen.ts"), renderGuestRouter(model, GUEST_EXPOSED));
  writeFileSync(join(GEN_DIR, "schema.gen.ts"), renderSchema(model));
  writeFileSync(join(GEN_DIR, "jobs.gen.ts"), renderJobs(model));
  writeFileSync(join(GEN_DIR, "http.gen.ts"), renderHttp(model));
  writeFileSync(join(GEN_DIR, "workflows.gen.ts"), renderWorkflows(model));
  writeFileSync(join(GEN_DIR, "activities.gen.ts"), renderActivities(model));
  writeFileSync(join(GEN_DIR, "schedules.gen.ts"), renderSchedules(model));
  writeFileSync(join(MANAGE_EXT_DIR, "rules.gen.json"), renderRules());
  writeFileSync(join(MANAGE_EXT_DIR, "manifest.json"), renderManifest());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
