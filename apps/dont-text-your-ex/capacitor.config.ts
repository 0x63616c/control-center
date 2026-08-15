import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "co.worldwidewebb.textyourex",
  appName: "Text Your Ex",
  // Vite builds the web app into apps/frontend/dist; Capacitor bundles that offline.
  webDir: "apps/frontend/dist",
  // Native view bg black so safe-area insets / overscroll never flash white.
  backgroundColor: "#000000",
  ios: {
    // "never" so the native scroll view does NOT also inset for safe areas; CSS
    // env(safe-area-inset-*) in App.tsx is the single owner (viewport-fit=cover).
    // "always" double-stacked with the CSS padding -> huge top/bottom bars.
    contentInset: "never",
    backgroundColor: "#000000",
  },
};

export default config;
