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
import { DEFAULT_METRICS_PORT } from "../metrics/port";
import { enumOf, int, num, pgUrl, secret, str, url } from "./fields";
import { defineEnv } from "./registry";

export const ENV = defineEnv({
  // ── Infra / process ──────────────────────────────────────────────────────
  NODE_ENV: enumOf("development", "production", "test").default("development"),
  PORT: int().default(4201).forRuntime("api"),
  BUILD_HASH: str().default("dev"),
  // Prometheus exposition listener (#214). A DEDICATED port on every backend
  // runtime, never a route on the service's own port: the api's :4201 is mapped
  // through the Cloudflare tunnel, so /metrics there would be public. 9464 is
  // the conventional Prometheus-exporter port. No `.forRuntime()` — api,
  // worker and temporal-worker all serve it, and the default is always right
  // in-cluster (nothing else in a pod binds it), so it is never set in prod.
  METRICS_PORT: int().default(DEFAULT_METRICS_PORT),

  // ── Database (11 features + core) ─────────────────────────────────────────
  DATABASE_URL: pgUrl().required().devDefault("postgresql://cc:cc@localhost:5432/controlcenter"),

  // ── Home Assistant (ac, ctrl, dogcam, tesla, tv) ──────────────────────────
  HA_URL: url().default("http://homeassistant.local:8123"),
  HA_TOKEN: secret()
    .required()
    .forRuntime("api", "worker")
    .forFeatures("ac", "ctrl", "dogcam", "tesla", "tv"),
  CLIMATE_ENTITY_ID: str().default("climate.home").forRuntime("api").forFeatures("ac"),

  // ── UniFi / Wi-Fi (network, guest-wifi) ───────────────────────────────────
  UNIFI_API_KEY: secret().required().forRuntime("api").forFeatures("network"),
  UNIFI_CONTROLLER_URL: url()
    .default("https://192.168.0.1")
    .forRuntime("api")
    .forFeatures("network"),
  UNIFI_SITE_ID: str().default("default").forRuntime("api").forFeatures("network"),
  WIFI_SSID: secret().required().forRuntime("api").forFeatures("network"),
  WIFI_PASSWORD: secret().required().forRuntime("api").forFeatures("network"),
  WIFI_GUEST_SSID: secret().required().forRuntime("api").forFeatures("network"),

  // ── Home location (tesla, weather) ────────────────────────────────────────
  HOME_LAT: num().required().devDefault(34.0537).forRuntime("api", "worker").forFeatures("weather"),
  HOME_LON: num()
    .required()
    .devDefault(-118.2428)
    .forRuntime("api", "worker")
    .forFeatures("weather"),
  HOME_PLACE_NAME: str().default("Home").forFeatures("weather"),
  HOME_RADIUS_MILES: num().default(1).forRuntime("api").forFeatures("tesla"),

  // ── GitHub webhooks (hooks) ───────────────────────────────────────────────
  // The shared secret GitHub signs every delivery with. hooks. is a PUBLIC host
  // with no Cloudflare Access in front, so this HMAC is the auth boundary: the
  // webhook relay verifies it first at the public edge, and the api verifies it
  // again in-cluster as defence in depth. Required for both — booting the api
  // without it would open a write endpoint.
  GITHUB_BOT_WEBHOOK_SECRET: secret().required().forRuntime("api").forFeatures("hooks"),

  // ── Tesla (ac, tesla) ─────────────────────────────────────────────────────
  TESLA_ENTITY_PREFIX: str().default("evee").forRuntime("api").forFeatures("tesla"),

  // ── Media storage (booth, wakes) ──────────────────────────────────────────
  MEDIA_STORAGE_DIR: str().default("/mnt/media").forRuntime("api").forFeatures("booth", "wakes"),

  // ── Spotify (sound) ───────────────────────────────────────────────────────
  SPOTIFY_CLIENT_ID: secret().optionalSecret().forRuntime("api").forFeatures("sound"),
  SPOTIFY_CLIENT_SECRET: secret().optionalSecret().forRuntime("api").forFeatures("sound"),
  SPOTIFY_REFRESH_TOKEN: secret().optionalSecret().forRuntime("api").forFeatures("sound"),

  // ── Withings direct-poll ingest (weight) ──────────────────────────────────
  // No WITHINGS_REFRESH_TOKEN/ACCESS_TOKEN here: Withings rotates the refresh
  // token on every use, so the live pair lives in Postgres (withings_oauth_token),
  // not env/vault. Only the static app credentials live here.
  WITHINGS_CLIENT_ID: secret().optionalSecret().forRuntime("worker").forFeatures("weight"),
  WITHINGS_CLIENT_SECRET: secret().optionalSecret().forRuntime("worker").forFeatures("weight"),

  // ── App Store Connect poll (worker) ───────────────────────────────────────
  ASC_KEY_ID: secret().optionalSecret().forRuntime("worker").forFeatures("panel-update"),
  ASC_ISSUER_ID: secret().optionalSecret().forRuntime("worker").forFeatures("panel-update"),
  ASC_KEY_CONTENT: secret().optionalSecret().forRuntime("worker").forFeatures("panel-update"),
  ASC_APP_ID: str().default("6762095888").forRuntime("worker").forFeatures("panel-update"),

  // ── Deploys (deploys) ─────────────────────────────────────────────────────
  GITHUB_ACTIONS_TOKEN: secret().optionalSecret().forRuntime("worker").forFeatures("deploys"),
  GITHUB_REPO: str()
    .default("0x63616c/world-wide-webb")
    .forRuntime("worker")
    .forFeatures("deploys"),

  // ── APNs push (notif) ─────────────────────────────────────────────────────
  APNS_KEY_ID: secret()
    .optionalSecret()
    .forRuntime("worker", "temporal-worker")
    .forFeatures("notif"),
  APNS_TEAM_ID: secret()
    .optionalSecret()
    .forRuntime("worker", "temporal-worker")
    .forFeatures("notif"),
  APNS_KEY_CONTENT: secret()
    .optionalSecret()
    .forRuntime("worker", "temporal-worker")
    .forFeatures("notif"),
  APNS_BUNDLE_ID: str()
    .default("co.worldwidewebb.theworkflowengine")
    .forRuntime("worker", "temporal-worker")
    .forFeatures("notif"),
  APNS_HOST: url().default("https://api.push.apple.com").forRuntime("worker").forFeatures("notif"),
  PUSH_TOKEN_KEYRING: secret().optionalSecret().forRuntime("api", "temporal-worker"),

  // ── Don't Text Your Ex account deletion / Sign in with Apple ─────────────
  SIWA_KEY_ID: secret().optionalSecret().forRuntime("temporal-worker"),
  SIWA_TEAM_ID: secret().optionalSecret().forRuntime("temporal-worker"),
  SIWA_KEY_CONTENT: secret().optionalSecret().forRuntime("temporal-worker"),
  APPLE_BUNDLE_ID: str()
    .default("co.worldwidewebb.textyourex")
    .forRuntime("api", "temporal-worker"),
  ACCOUNT_DELETION_KEYRING: secret().optionalSecret().forRuntime("api", "temporal-worker"),
  RESTORE_TOMBSTONE_HMAC_KEYRING: secret().optionalSecret().forRuntime("api", "temporal-worker"),
  RESTORE_TOMBSTONE_SIGNING_KEYRING: secret().optionalSecret().forRuntime("api", "temporal-worker"),
  ERASURE_JOURNAL_DIR: str().optional().forRuntime("api", "temporal-worker"),

  // ── Camera / go2rtc (dogcam) ──────────────────────────────────────────────
  GO2RTC_URL: url().default("http://go2rtc:1984").forRuntime("api").forFeatures("dogcam"),
  CAMERA_STREAM_NAME: str().default("bedroom_mjpeg").forRuntime("api").forFeatures("dogcam"),
  CAMERA_LABEL: str().default("Living Room Cam").forRuntime("api").forFeatures("dogcam"),

  // ── Temporal (temporal-worker) ────────────────────────────────────────────
  // All three carry safe in-cluster defaults, so the temporal-worker Deployment
  // needs no Temporal env at all and still lands on the right
  // server/namespace/queue. (The old TEMPORAL_HEALTH_CHECK_ITERATIONS knob
  // became plain facet data in features/temporal-health/temporal.ts, ADR-0008.)
  TEMPORAL_ADDRESS: str().default("temporal-server.temporal.svc.cluster.local:7233"),
  TEMPORAL_NAMESPACE: str().default("control-center"),
  TEMPORAL_TASK_QUEUE: str().default("main"),
  // Where the worker's Runtime.install({ telemetryOptions }) sends SDK-internal
  // metrics (workflow/activity completions, schedule-to-start, sticky-cache
  // hit rate, poller counts — see #233). This is the SDK's own OTel exporter,
  // separate from METRICS_PORT above (this worker's app-level
  // @www/platform/metrics listener) — the two are deliberately not merged.
  // The collector this points at (infra/src/temporal.ts's
  // temporal-otel-collector) re-exports to Prometheus over its own
  // annotation-discovered scrape port, so no dedicated scrape job exists for
  // it either.
  TEMPORAL_OTEL_COLLECTOR_URL: url().default(
    "http://temporal-otel-collector.temporal.svc.cluster.local:4317",
  ),

  // ── Guest listener (api/guest-server, ADR-0006) ───────────────────────────
  GUEST_PORT: int().optional().forRuntime("api"),
  GUEST_TLS_DIR: str().optional().forRuntime("api"),
  GUEST_STATIC_DIR: str().optional().forRuntime("api"),
  GUEST_HTTP_PORT: int().optional().forRuntime("api"),
});
