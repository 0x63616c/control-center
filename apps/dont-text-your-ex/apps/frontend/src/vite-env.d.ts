/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API base for native (Capacitor) builds, e.g. https://api.textyourex.app. Empty on web → relative /api. */
  readonly VITE_API_BASE?: string;
  readonly VITE_APNS_ENVIRONMENT?: "production" | "sandbox";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
