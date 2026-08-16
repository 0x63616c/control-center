import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Real-Postgres suites share one database and perform fixture cleanup.
    // Keep files in one process so those resets cannot race each other.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
