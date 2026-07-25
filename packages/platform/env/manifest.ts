/**
 * THE env manifest — every environment key the whole system reads, declared
 * exactly once (design spec §4, goal 2 & 4). Feature configs become typed
 * projections of this via `ENV.pick(...)`; nothing re-declares a key or its
 * default. Answers "what does prod need?" in one file.
 *
 * Requiredness tiers:
 * - `.required()`            — must be present in prod; `assertEnv` crashes if
 *                             missing. No prod default (may carry `.devDefault`
 *                             for local dev only).
 * - `.optionalSecret()`     — a secret with no default; resolves to `undefined`
 *                             at runtime when unset, but keeps its static type
 *                             `string` so gate-guarded consumers typecheck.
 * - `.default(v)`           — safe, public, non-secret default; same everywhere.
 * - `.optional()`           — may be absent anywhere → `undefined`.
 *
 * Hydration inputs (POSTGRES_PASSWORD*, POSTGRES_HOST/PORT/USER/DB) are NOT keys
 * here — they feed `databaseUrlFromSecret()` in hydrate.ts to derive
 * DATABASE_URL (design spec §4 "Hydration inputs").
 */
import { bool, enumOf, int, num, pgUrl, secret, str, url } from "./fields";
import { defineEnv } from "./registry";

export const ENV = defineEnv({
  // ── Infra / process ──────────────────────────────────────────────────────
  NODE_ENV: enumOf("development", "production", "test").default("development"),
  PORT: int().default(4201).forRuntime("api"),
  BUILD_HASH: str().default("dev"),

  // ── Database (11 features + core) ─────────────────────────────────────────
  DATABASE_URL: pgUrl().required().devDefault("postgresql://cc:cc@localhost:5432/controlcenter"),

  // ── Home Assistant (ac, ctrl, dogcam, tesla, tv) ──────────────────────────
  HA_URL: url().default("http://homeassistant.local:8123"),
  HA_TOKEN: secret().required().forRuntime("api", "worker").forFeature("ac"),
  CLIMATE_ENTITY_ID: str().default("climate.home").forRuntime("api").forFeature("ac"),
  HA_WEIGHT_ENTITY_ID: str()
    .default("sensor.renpho_scale_weight")
    .forRuntime("worker")
    .forFeature("weight"),

  // ── UniFi / Wi-Fi (network, guest-wifi) ───────────────────────────────────
  UNIFI_API_KEY: secret().required().forRuntime("api").forFeature("network"),
  UNIFI_CONTROLLER_URL: url()
    .default("https://192.168.0.1")
    .forRuntime("api")
    .forFeature("network"),
  UNIFI_SITE_ID: str().default("default").forRuntime("api").forFeature("network"),
  WIFI_SSID: secret().required().forRuntime("api").forFeature("network"),
  WIFI_PASSWORD: secret().required().forRuntime("api").forFeature("network"),
  WIFI_GUEST_SSID: secret().required().forRuntime("api").forFeature("network"),

  // ── Home location (tesla, weather) ────────────────────────────────────────
  HOME_LAT: num().required().devDefault(34.0537).forRuntime("api", "worker").forFeature("weather"),
  HOME_LON: num()
    .required()
    .devDefault(-118.2428)
    .forRuntime("api", "worker")
    .forFeature("weather"),
  HOME_PLACE_NAME: str().default("Home").forFeature("weather"),
  HOME_RADIUS_MILES: num().default(1).forRuntime("api").forFeature("tesla"),

  // ── Tesla (ac, tesla) ─────────────────────────────────────────────────────
  TESLA_ENTITY_PREFIX: str().default("evee").forRuntime("api").forFeature("tesla"),

  // ── Media (booth, wakes, worker) ──────────────────────────────────────────
  MEDIA_STORAGE_DIR: str().default("/mnt/media").forRuntime("worker", "api").forFeature("booth"),
  YOUTUBE_INGEST_ENABLED: bool().default(false).forRuntime("worker").forFeature("sound"),

  // ── Spotify (sound) ───────────────────────────────────────────────────────
  SPOTIFY_CLIENT_ID: secret().optionalSecret().forRuntime("api").forFeature("sound"),
  SPOTIFY_CLIENT_SECRET: secret().optionalSecret().forRuntime("api").forFeature("sound"),
  SPOTIFY_REFRESH_TOKEN: secret().optionalSecret().forRuntime("api").forFeature("sound"),

  // ── Withings direct-poll ingest (weight) ──────────────────────────────────
  // No WITHINGS_REFRESH_TOKEN/ACCESS_TOKEN here: Withings rotates the refresh
  // token on every use, so the live pair lives in Postgres (withings_oauth_token),
  // not env/vault. Only the static app credentials live here.
  WITHINGS_CLIENT_ID: secret().optionalSecret().forRuntime("worker").forFeature("weight"),
  WITHINGS_CLIENT_SECRET: secret().optionalSecret().forRuntime("worker").forFeature("weight"),

  // ── App Store Connect poll (worker) ───────────────────────────────────────
  ASC_KEY_ID: secret().optionalSecret().forRuntime("worker").forFeature("worker"),
  ASC_ISSUER_ID: secret().optionalSecret().forRuntime("worker").forFeature("worker"),
  ASC_KEY_CONTENT: secret().optionalSecret().forRuntime("worker").forFeature("worker"),
  ASC_APP_ID: str().default("6762095888").forRuntime("worker").forFeature("worker"),

  // ── Deploys (deploys) ─────────────────────────────────────────────────────
  GITHUB_ACTIONS_TOKEN: secret().optionalSecret().forRuntime("worker").forFeature("deploys"),
  GITHUB_REPO: str().default("0x63616c/world-wide-webb").forRuntime("worker").forFeature("deploys"),

  // ── APNs push (notif) ─────────────────────────────────────────────────────
  APNS_KEY_ID: secret().optionalSecret().forRuntime("worker").forFeature("notif"),
  APNS_TEAM_ID: secret().optionalSecret().forRuntime("worker").forFeature("notif"),
  APNS_KEY_CONTENT: secret().optionalSecret().forRuntime("worker").forFeature("notif"),
  APNS_BUNDLE_ID: str()
    .default("co.worldwidewebb.theworkflowengine")
    .forRuntime("worker")
    .forFeature("notif"),
  APNS_HOST: url().default("https://api.push.apple.com").forRuntime("worker").forFeature("notif"),

  // ── Camera / go2rtc (dogcam) ──────────────────────────────────────────────
  GO2RTC_URL: url().default("http://go2rtc:1984").forRuntime("api").forFeature("dogcam"),
  CAMERA_STREAM_NAME: str().default("bedroom_mjpeg").forRuntime("api").forFeature("dogcam"),
  CAMERA_LABEL: str().default("Living Room Cam").forRuntime("api").forFeature("dogcam"),

  // ── Guest listener (api/guest-server, ADR-0006) ───────────────────────────
  GUEST_PORT: int().optional().forRuntime("api"),
  GUEST_TLS_DIR: str().optional().forRuntime("api"),
  GUEST_STATIC_DIR: str().optional().forRuntime("api"),
  GUEST_HTTP_PORT: int().optional().forRuntime("api"),
});
