import { execSync } from "node:child_process";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const apiPort = process.env.API_PORT ?? "4201";

// Identifies the running web bundle. CI passes the commit SHA via the BUILD_HASH
// env (Docker ARG → ENV); a local build reads the current short SHA from git.
// The Docker builder has no .git, so the env path is what production uses; the
// git path is the dev/preview convenience, with "dev" as the last-resort fallback.
function resolveBuildHash(): string {
  if (process.env.BUILD_HASH) return process.env.BUILD_HASH;
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
}

// Unix-ms timestamp of the running web bundle, for the "built N ago" readout.
// CI passes the commit time via BUILD_TIME; a local build reads the current
// commit's author date from git. Returns "NaN" (the string) when unknown so
// that Number("NaN") correctly parses to NaN , callers treat non-finite as
// "no age to show". An empty string must NOT be returned: Number("") === 0,
// which is finite and causes formatRelativeAge to render "56 years".
function resolveBuildTime(): string {
  if (process.env.BUILD_TIME) return process.env.BUILD_TIME;
  try {
    const secs = execSync("git log -1 --format=%ct").toString().trim();
    return String(Number(secs) * 1000);
  } catch {
    return "NaN";
  }
}

// Resolve once so the value baked into the bundle (__BUILD_HASH__) and the value
// written to dist/version.json are GUARANTEED identical , the kiosk version check
// (www-ss8s) compares the served version.json hash against the baked BUILD_HASH,
// so any divergence here would cause spurious or missed reloads.
const buildHash = resolveBuildHash();

// Emits dist/version.json = {"hash":"<SHA>"} at build, served by nginx at the
// site root (/version.json). The web app polls it to detect OTA deploys.
function versionStampPlugin(hash: string): Plugin {
  return {
    name: "cc-version-stamp",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ hash }),
      });
    },
  };
}

export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: "react" }),
    react(),
    tailwindcss(),
    versionStampPlugin(buildHash),
  ],
  define: {
    __BUILD_HASH__: JSON.stringify(buildHash),
    __BUILD_TIME__: JSON.stringify(resolveBuildTime()),
  },
  resolve: {
    // Authoring-surface aliases (Track C, C7). `@app-kit/server` MUST precede
    // `@app-kit`: vite matches a string alias when the importee equals it or
    // starts with `alias + "/"`, so a bare `@app-kit` entry first would swallow
    // `@app-kit/server`. Kept in sync with the root + web tsconfig `paths` and
    // check-alias-parity.sh.
    alias: {
      "@": resolve(__dirname, "src"),
      "@app-kit/server": resolve(__dirname, "../../app-kit/server.ts"),
      "@app-kit": resolve(__dirname, "../../app-kit/index.ts"),
      "@features": resolve(__dirname, "../../features"),
    },
  },
  // Pre-bundle deps Vite would otherwise discover + optimize MID-RUN during the
  // Storybook browser test project (which extends this config), forcing a reload
  // that fails the run ("Vite unexpectedly reloaded a test") on a cold CI cache.
  // - @tanstack/react-router: the storybook preview imports the tile-registry →
  //   container tiles → lib/trpc → @tanstack/react-router.
  // - @capacitor/*: lib/brightness (idle-dim) pulls these in; the board's idle
  //   hooks reach them transitively, so a cold cache optimizes them mid-test.
  // (Reproduce the CI condition locally by clearing node_modules/.vite first.)
  // @capacitor/app joined via AppUpdateBanner (its stories pull lib/app-update).
  optimizeDeps: {
    include: [
      "@tanstack/react-router",
      "@capacitor/app",
      "@capacitor/core",
      "@capacitor/status-bar",
      "@capacitor-community/screen-brightness",
    ],
  },
  server: {
    host: true,
    port: Number(process.env.PORT ?? 4200),
    proxy: {
      // Match production nginx for photo uploads and stored media as well as artwork.
      "/media/progress": { target: `http://localhost:${apiPort}`, changeOrigin: true },
      "/trpc": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        ws: true,
      },
      "/media/tv-artwork": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      // Long-lived MJPEG camera stream (multipart/x-mixed-replace) proxied to the
      // api, which fronts go2rtc. Must NOT be buffered or timed out , the response
      // never ends by design.
      "/media/camera-stream": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
