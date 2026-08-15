import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const HOST = "127.0.0.1";
// API port (Hono) + the frontend preview port the browser actually loads. The
// frontend serves the built dist via `vite preview` and proxies /api to the API
// (VITE_PROXY_TARGET), mirroring production's separate frontend/api surfaces.
const PORT = 18788;
const WEB_PORT = 15173;

// E2E tests require a real Postgres instance. Set DATABASE_URL to point at one.
// Local dev: run `tilt up` (starts Docker Postgres) then `bun run e2e`.
// CI: a postgres service container sets DATABASE_URL automatically.
// If DATABASE_URL is unset, the webServer command will fail and tests are skipped.
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:devpass@localhost:5432/text_your_ex";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // shared Postgres DB per run, run serially to avoid races
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    // The browser loads the built React frontend (vite preview), NOT the API.
    baseURL: `http://${HOST}:${WEB_PORT}`,
    viewport: { width: 1200, height: 980 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // TYE_RESET=1 truncates all tables before explicit e2e seeding.
      command: `TYE_RESET=1 DATABASE_URL=${DATABASE_URL} APP_ENV=development PORT=${PORT} bun run ${root}/apps/api/src/index.ts`,
      port: PORT,
      timeout: 30_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Serve the built frontend (pretest runs `vite build`) and proxy /api to the
      // API above. Without this the browser hit the API origin and got JSON/404.
      command: `VITE_PROXY_TARGET=http://${HOST}:${PORT} bun run --cwd ${root}/apps/frontend preview --port ${WEB_PORT} --strictPort --host ${HOST}`,
      port: WEB_PORT,
      timeout: 30_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
