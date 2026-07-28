import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The spec launches its own persistent contexts (MV3 extensions need a
  // profile), so no `use.browserName` / projects here — and no parallelism,
  // since each arm launches a real browser.
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  timeout: 60_000,
});
