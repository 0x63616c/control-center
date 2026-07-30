import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Root workspace: api + web unit tests. Storybook browser tests run separately via
// `bunx vitest --project storybook` from apps/web/ (requires Playwright/Chromium).
export default defineConfig({
  test: {
    projects: [
      "apps/api",
      "apps/web",
      "apps/manage",
      "apps/worker",
      "packages/core",
      "packages/logger",
      "packages/platform",
      "packages/worker-runtime",
      // The `infra` project's default test glob also covers infra/unifi/test/**
      // (UniFi adopt-only stack, www-j934.3), so no separate project entry is
      // needed; a second entry would double-run those tests.
      "infra",
      // app-kit: the App authoring surface (defineApp/defineApi/defineJobs/
      // defineCron brand checks). No package.json/vite config of its own
      // (like test/scripts/apps-gen below), and define-app.test.ts only imports
      // sibling files via relative paths, so a bare inline project (no react
      // plugin, no jsdom, no aliases) is enough.
      {
        test: {
          name: "app-kit",
          root: "./app-kit",
          include: ["**/*.test.ts"],
        },
      },
      // test/scripts/apps-gen: tests for the codegen collector/validator (Track C Slice 3).
      // No package.json/vite config of its own (the production code is a scripts/ subdir, not a
      // workspace package), so it needs an inline project definition rather
      // than a directory reference. collect.ts imports apps/web's
      // TILE_REGISTRY, which transitively imports TSX tile components, so
      // this project needs apps/web's "@" alias + the react plugin + jsdom
      // (mirrors apps/web/vitest.config.ts) even though validate.ts itself is
      // plain Node-shaped.
      {
        plugins: [react()],
        resolve: {
          alias: {
            "@": resolve(__dirname, "apps/web/src"),
            // Authoring-surface aliases (Track C, C7). test/scripts/alias-parity.test.ts
            // imports `@app-kit` to prove vitest resolves it identically to tsc,
            // bun, and vite. `@app-kit/server` precedes `@app-kit` (prefix match).
            // Kept in sync with the tsconfig `paths`, vite.config.ts, and
            // check-alias-parity.sh.
            "@app-kit/server": resolve(__dirname, "app-kit/server.ts"),
            "@app-kit": resolve(__dirname, "app-kit/index.ts"),
            "@features": resolve(__dirname, "features"),
          },
        },
        test: {
          name: "apps-gen",
          // root stays "./test/scripts" (not "./test/scripts/apps-gen") so this project's
          // default include glob also reaches apps-check.test.ts, a sibling of
          // the apps-gen suites (Task 3.4).
          // apps-check.ts drives the SAME collect()/validate()/renderTiles()
          // chain as apps-gen/*.ts, so it needs the identical jsdom + "@" alias
          // + MapLibre stub environment, not a separate project.
          root: "./test/scripts",
          include: [
            "apps-gen/**/*.test.ts",
            "apps-check.test.ts",
            "alias-parity.test.ts",
            "check.test.ts",
          ],
          environment: "jsdom",
          // Same MapLibre stub as apps/web's unit project (www-355t.11):
          // collect() pulls in the real TILE_REGISTRY, which imports
          // maplibre-gl-backed tiles (Tesla), and jsdom has no WebGL.
          setupFiles: [resolve(__dirname, "apps/web/vitest.setup.unit.ts")],
        },
      },
    ],
    // 4 workers: public-repo runners are 4 vCPU / 16GB. Peak RSS was measured at
    // ~1.5GB per worker back when v8 coverage was still instrumented; without it
    // 4 workers sit well under half the available RAM, so cores are the binding
    // constraint, not memory. Measured parallel efficiency at 2 workers was 89%
    // (386.9s of phase work in 218.5s wall), so this scales close to linearly.
    // If the suite starts flaking on timing-sensitive Board tests, or a worker
    // OOMs, drop back to 2 — this is a tuning knob, not a correctness boundary.
    maxWorkers: 4,
    pool: "forks",
    // An empty collection must never make sandbox or CI verification look green.
    passWithNoTests: false,
    // Coverage config lives here (not as CLI flags) so it can carry include/
    // exclude + thresholds; per-project config is ignored once `projects` is set,
    // so the root config is the only one that matters (www-355t.11). Without an
    // explicit `include`, v8 counts every transitively-loaded module
    // (node_modules, maplibre, …) and the line/statement % is meaningless.
    coverage: {
      provider: "v8",
      reporter: ["json-summary", "text-summary"],
      include: ["apps/{api,web,worker}/src/**", "packages/*/src/**"],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        "**/*.stories.*",
        "**/__tests__/**",
        "**/db/migrations/**",
        "**/*.d.ts",
        "**/*.gen.ts",
      ],
      // Coverage is REPORTED but deliberately NOT gated - no `thresholds` here.
      // A coverage drop must never fail a CI job or block a deploy (per Calum);
      // the merged browser+unit number is also slightly nondeterministic
      // run-to-run, so a ratchet would flake. The test-unit/test-storybook jobs
      // still fail on real test failures, just never on the coverage %.
    },
  },
});
