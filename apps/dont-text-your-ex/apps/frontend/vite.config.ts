import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEV_PORT = 5173;
const DEV_HOST = "192.168.0.250";

// VITE_API_BASE: baked at Docker build time for Capacitor/prod builds (no runtime server).
// In local dev the Vite dev server proxies /api to localhost:8787 (VITE_API_BASE unused).
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: DEV_PORT,
    strictPort: true,
    hmr: {
      host: DEV_HOST,
      port: DEV_PORT,
    },
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  // `vite preview` (serving the built dist) needs its own proxy: the e2e harness
  // serves the built frontend via preview and proxies /api to the e2e API port
  // (VITE_PROXY_TARGET). Defaults to the dev API port for a manual `vite preview`.
  preview: {
    host: "0.0.0.0",
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      "/api": {
        // biome-ignore lint/style/noProcessEnv: node-side vite config, env override is intentional
        target: process.env.VITE_PROXY_TARGET ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
