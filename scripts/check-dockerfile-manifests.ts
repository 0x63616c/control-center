#!/usr/bin/env bun
/**
 * Guard: every full-install Dockerfile must COPY all workspace package.json files.
 *
 * Source of truth: bun.lock's "workspaces" keys (the set bun actually resolves).
 * This catches mismatches like a package added to workspaces without updating Dockerfiles.
 *
 * Run: bun run scripts/check-dockerfile-manifests.ts
 * Exits non-zero if any full-install Dockerfile is missing a workspace manifest.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// --- 1. Parse workspace list from bun.lock (authoritative - bun resolves from this) ---

function parseBunLockWorkspaces(): string[] {
  const lockPath = join(ROOT, "bun.lock");
  if (!existsSync(lockPath)) {
    console.error("ERROR: bun.lock not found at repo root");
    process.exit(1);
  }
  // bun.lock is JSONC (trailing commas) - use Bun's built-in require to parse it
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const data = require(lockPath) as { workspaces?: Record<string, unknown> };
  return Object.keys(data.workspaces ?? {})
    .filter((k) => k !== "") // exclude root ""
    .map((k) => `${k}/package.json`)
    .sort();
}

const workspaceManifests = parseBunLockWorkspaces();

if (workspaceManifests.length === 0) {
  console.error("ERROR: found 0 workspace manifests in bun.lock - parsing failed");
  process.exit(1);
}

// --- 2. Dockerfiles that run `bun install --frozen-lockfile` against the full workspace graph ---
//
// These are built from the repo root (.), so they must COPY every workspace manifest
// before the frozen install. Some Dockerfiles use a product-dir context and
// relative paths (apps/*), so it is intentionally excluded.

const FULL_INSTALL_DOCKERFILES = [
  "apps/manage/Dockerfile",
  "apps/api/Dockerfile",
  "apps/worker/Dockerfile",
  "apps/temporal-worker/Dockerfile",
  "apps/web/Dockerfile",
  "apps/software-factory/web/Dockerfile",
];

// --- 3. Parse each Dockerfile for `COPY <src>/package.json` lines ---

function parseCopiedManifests(dockerfilePath: string): Set<string> {
  const content = readFileSync(join(ROOT, dockerfilePath), "utf8");
  const copied = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("COPY ")) continue;
    // Matches: COPY some/path/package.json [./]dest/...
    const m = trimmed.match(/^COPY\s+(\S+\/package\.json)\s+/);
    if (m) {
      copied.add(m[1].replace(/^\.\//, ""));
    }
  }
  return copied;
}

// --- 4. Assert every Dockerfile covers every workspace manifest ---

let exitCode = 0;
const allMissing: Array<{ dockerfile: string; missing: string[] }> = [];

for (const df of FULL_INSTALL_DOCKERFILES) {
  if (!existsSync(join(ROOT, df))) {
    console.warn(`WARN: Dockerfile not found, skipping: ${df}`);
    continue;
  }
  const copied = parseCopiedManifests(df);
  const missing = workspaceManifests.filter((m) => !copied.has(m));
  if (missing.length > 0) {
    allMissing.push({ dockerfile: df, missing });
    exitCode = 1;
  }
}

// --- 4b. Assert no full-install Dockerfile uses a FLOATING oven/bun base tag ---
//
// `oven/bun:1-alpine` / `:latest` drift to the newest bun (e.g. 1.3.x), whose
// lockfile format the 1.2-generated bun.lock can't satisfy under
// --frozen-lockfile ("lockfile had changes"). Pin to a minor (oven/bun:1.2...),
// matching the CI setup-bun pin. This has broken builds before (captive-portal).
const FLOATING_BUN = /FROM\s+oven\/bun:(1-|latest|1\s|1$)/;
const floatingBunOffenders: string[] = [];
for (const df of FULL_INSTALL_DOCKERFILES) {
  if (!existsSync(join(ROOT, df))) continue;
  const content = readFileSync(join(ROOT, df), "utf8");
  for (const line of content.split("\n")) {
    if (FLOATING_BUN.test(line.trim())) {
      floatingBunOffenders.push(`  ${df}: ${line.trim()}`);
      exitCode = 1;
    }
  }
}

// --- 4c. Assert every full-install Dockerfile COPYs the C7 authoring-surface
// source dirs (app-kit/ + features/). These are root-level source trees, NOT
// workspaces (no package.json), so section 4 doesn't cover them; web bundles
// feature tiles, api mounts feature routers/schema, worker drains feature jobs,
// so all three images must copy them in. A miss ships an image that can't
// resolve @app-kit/@features at build time.
//
// Scoped to the images that actually CONSUME that surface, not to every
// full-install Dockerfile: apps/temporal-worker serves the Temporal task queue
// and imports no feature facet, so copying features/ in would ship a tree the
// image never reads (and hand it a rebuild on every unrelated feature edit).
// An image that starts draining feature work belongs on this list.
const REQUIRED_SOURCE_DIRS = ["app-kit", "features"];
const C7_AUTHORING_SURFACE_DOCKERFILES = [
  "apps/api/Dockerfile",
  "apps/worker/Dockerfile",
  "apps/web/Dockerfile",
];
const sourceDirOffenders: Array<{ dockerfile: string; missing: string[] }> = [];
for (const df of C7_AUTHORING_SURFACE_DOCKERFILES) {
  if (!existsSync(join(ROOT, df))) continue;
  const content = readFileSync(join(ROOT, df), "utf8");
  const copiedDirs = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("COPY ")) continue;
    // Matches: COPY <dir> [./]<dir>  (a whole-directory source copy, not a file)
    const m = trimmed.match(/^COPY\s+(\S+)\s+/);
    if (m) copiedDirs.add(m[1].replace(/^\.\//, ""));
  }
  const missing = REQUIRED_SOURCE_DIRS.filter((d) => !copiedDirs.has(d));
  if (missing.length > 0) {
    sourceDirOffenders.push({ dockerfile: df, missing });
    exitCode = 1;
  }
}

// --- 5. Report ---

if (sourceDirOffenders.length > 0) {
  console.error(
    "✗ Dockerfile(s) missing C7 authoring-surface source COPYs (app-kit/ + features/):",
  );
  for (const { dockerfile, missing } of sourceDirOffenders) {
    console.error(`  ${dockerfile}:`);
    for (const d of missing) console.error(`    + COPY ${d} ./${d}`);
  }
  console.error("");
}

if (floatingBunOffenders.length > 0) {
  console.error(
    `✗ Floating oven/bun base tag(s) (drift to a lockfile-incompatible bun); pin to a minor like oven/bun:1.2-alpine:\n${floatingBunOffenders.join("\n")}\n`,
  );
}

if (exitCode === 0) {
  console.log(
    `✓ All ${FULL_INSTALL_DOCKERFILES.length} frozen-install Dockerfiles cover all ${workspaceManifests.length} workspace manifests from bun.lock and use pinned bun base tags; the ${C7_AUTHORING_SURFACE_DOCKERFILES.length} C7 images COPY the authoring-surface dirs (${REQUIRED_SOURCE_DIRS.join(", ")}).`,
  );
} else if (allMissing.length > 0) {
  console.error(
    `✗ ${allMissing.length} Dockerfile(s) are missing workspace manifests in their COPY list:\n`,
  );
  for (const { dockerfile, missing } of allMissing) {
    console.error(`  ${dockerfile}:`);
    for (const m of missing) {
      console.error(`    + COPY ${m} ./${m}`);
    }
    console.error();
  }
  console.error(
    "Add the missing COPY lines before `RUN bun install --frozen-lockfile` in each Dockerfile.",
  );
}

process.exit(exitCode);
