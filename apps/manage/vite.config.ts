import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    host: true,
    // Fixed, not env-overridable: the extension's content-script match patterns
    // are generated and the local-run instructions name this port, so a
    // per-shell override would just mean manage silently reporting "extension
    // missing" on someone else's machine.
    // 4210, clear of apps/web (4200) and api (4201) so both can run at once.
    port: 4210,
  },
});
