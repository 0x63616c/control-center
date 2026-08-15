import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "tye-api",
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    // These suites share one Postgres; run every file in a single process so
    // their migrate/truncate/insert steps can't race across parallel workers.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Tests require a real Postgres instance.
    // Locally: docker run -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:17-alpine
    // then: DATABASE_URL=postgresql://postgres:test@localhost:5432/tye_test bun run test --project tye-api
    // In CI: DATABASE_URL set by the postgres service container.
  },
});
