export { genId } from "./id";

export const productSlugs = ["control-center", "captive-portal"] as const;

export type ProductSlug = (typeof productSlugs)[number];

export type ProductLabels = Readonly<{
  "app.kubernetes.io/component": string;
  "app.kubernetes.io/name": ProductSlug;
  "app.kubernetes.io/part-of": "world-wide-webb";
  "worldwidewebb.co/product": ProductSlug;
}>;

export type ProductIdentity = Readonly<{
  slug: ProductSlug;
  folder: `products/${ProductSlug}`;
  namespace: ProductSlug;
  imageNamespace: ProductSlug;
  labels: (component: string) => ProductLabels;
  pulumiName: (component: string) => string;
  serviceName: (component: string) => string;
  imageRepository: (component: string) => string;
  imageDigestKey: (component: string) => string;
  backupPathParts: (
    component: string,
  ) => readonly ["backups", "world-wide-webb", ProductSlug, string];
}>;

function assertNever(value: never): never {
  throw new Error(`Unhandled platform variant: ${String(value)}`);
}

export function defineProduct(slug: ProductSlug): ProductIdentity {
  const productPrefix = (component: string) => `${slug}-${component}`;

  return {
    slug,
    folder: `products/${slug}`,
    namespace: slug,
    imageNamespace: slug,
    labels: (component) => ({
      "app.kubernetes.io/component": component,
      "app.kubernetes.io/name": slug,
      "app.kubernetes.io/part-of": "world-wide-webb",
      "worldwidewebb.co/product": slug,
    }),
    pulumiName: productPrefix,
    serviceName: productPrefix,
    imageRepository: (component) => `ghcr.io/0x63616c/www-${slug}-${component}`,
    imageDigestKey: productPrefix,
    backupPathParts: (component) => ["backups", "world-wide-webb", slug, component],
  };
}

export type ImplementedTargetName = "homelab";

export type HomelabTarget = Readonly<{
  name: ImplementedTargetName;
  domain: "worldwidewebb.co";
  timezone: "America/Los_Angeles";
  nas: Readonly<{
    exportPath: "/volume1/Homelab";
    backupRootParts: readonly ["backups", "world-wide-webb"];
  }>;
  // Inlined (was the separately-exported TargetCapabilities type, ADR-0006):
  // homelab is the only implemented target, so a named plurality type here had
  // exactly one member and 0 external consumers.
  capabilities: Readonly<{
    certManager: boolean;
    cloudflareTunnel: boolean;
    cnpg: boolean;
    externalSecrets: boolean;
    k8s: boolean;
    nasBackups: boolean;
  }>;
}>;

export const implementedTargetNames = [
  "homelab",
] as const satisfies readonly ImplementedTargetName[];

export const homelabTarget = {
  name: "homelab",
  domain: "worldwidewebb.co",
  timezone: "America/Los_Angeles",
  nas: {
    exportPath: "/volume1/Homelab",
    backupRootParts: ["backups", "world-wide-webb"],
  },
  capabilities: {
    certManager: true,
    cloudflareTunnel: true,
    cnpg: true,
    externalSecrets: true,
    k8s: true,
    nasBackups: true,
  },
} as const satisfies HomelabTarget;

export function defineTarget(name: ImplementedTargetName): HomelabTarget {
  switch (name) {
    case "homelab":
      return homelabTarget;
  }
  return assertNever(name);
}

// Web hosts are a single label under the zone (`app.worldwidewebb.co`), so the
// free root wildcard `*.worldwidewebb.co` always covers them. There is exactly
// one coverage model: the exact single host. (The old `product-wildcard` mode
// built a 2-label `*.cc.worldwidewebb.co` wildcard that only paid ACM could
// issue; it was removed with ACM, www-kbiy.) Inlined below (was the
// separately-exported TlsCoverage/ExactHostTlsCoverage types, ADR-0006): a
// plurality type with exactly one member and 0 external consumers.
export type WebTlsRequirement = Readonly<{
  required: true;
  coverage: Readonly<{
    kind: "exact-host";
    hostname: string;
    dnsNames: readonly [string];
  }>;
}>;

export type WebHostOptions = Readonly<{ host: string }>;

export type WebExposure =
  | Readonly<{
      kind: "private-web";
      policy: "private";
      target: ImplementedTargetName;
      host: string;
      hostname: string;
      tls: WebTlsRequirement;
      cloudflareAccess: true;
    }>
  | Readonly<{
      // A host GitHub (or any other third party) must be able to POST to from
      // the public internet, so it is deliberately NOT Access-gated. There is
      // exactly one today, the webhook receiver, and its OWN auth is an HMAC
      // over the request body — Cloudflare is not the boundary. Never reach for
      // this to "make a page easier to load"; private-web is the default and
      // this kind is a security decision each time.
      kind: "public-web";
      policy: "public";
      target: ImplementedTargetName;
      host: string;
      hostname: string;
      tls: WebTlsRequirement;
      cloudflareAccess: false;
    }>
  | Readonly<{
      kind: "captive-portal-web";
      policy: "captive";
      target: ImplementedTargetName;
      host: string;
      hostname: string;
      tls: WebTlsRequirement;
    }>;

export type InternalServiceExposure = Readonly<{
  kind: "internal-service";
  policy: "internal";
  port: number;
}>;

function webHostname(target: HomelabTarget, host: string): string {
  // A SINGLE label under the zone (e.g. `app.worldwidewebb.co`) so the free
  // Cloudflare Universal SSL `*.worldwidewebb.co` (one-label wildcard) covers it.
  // A dotted "app dot cc" host would be two labels deep and would need paid ACM.
  return `${host}.${target.domain}`;
}

function webTlsRequirement(hostname: string): WebTlsRequirement {
  return {
    required: true,
    coverage: {
      kind: "exact-host",
      hostname,
      dnsNames: [hostname],
    },
  };
}

export function privateWeb(target: HomelabTarget, options: WebHostOptions): WebExposure {
  const hostname = webHostname(target, options.host);

  return {
    kind: "private-web",
    policy: "private",
    target: target.name,
    host: options.host,
    hostname,
    tls: webTlsRequirement(hostname),
    cloudflareAccess: true,
  };
}

/**
 * A publicly reachable, NON-Access-gated tunnel host. See the `public-web`
 * variant of {@link WebExposure} — using this means the service behind it owns
 * its own authentication.
 */
export function publicWeb(target: HomelabTarget, options: WebHostOptions): WebExposure {
  const hostname = webHostname(target, options.host);

  return {
    kind: "public-web",
    policy: "public",
    target: target.name,
    host: options.host,
    hostname,
    tls: webTlsRequirement(hostname),
    cloudflareAccess: false,
  };
}

export function captivePortalWeb(target: HomelabTarget, options: WebHostOptions): WebExposure {
  const hostname = webHostname(target, options.host);

  return {
    kind: "captive-portal-web",
    policy: "captive",
    target: target.name,
    host: options.host,
    hostname,
    tls: webTlsRequirement(hostname),
  };
}

export function internalService(options: { port: number }): InternalServiceExposure {
  return { kind: "internal-service", policy: "internal", port: options.port };
}

// The k8s namespace a service's target Secret lands in. Defaults to the owning
// product's namespace; only cloudflared varies (it lives in `cloudflare`).
export type SecretNamespace = ProductSlug | "cloudflare";

// A single declared secret. `vaultKey` is the operative reference: the SOPS
// ITEM__FIELD key in secrets/vault.yaml that vault.ts/eso.ts resolve (CC-k8t7
// replaced 1Password+ESO with SOPS+age). `item`/`field` are retained purely as
// provenance/audit metadata (which 1Password Homelab item the value came from);
// they are NOT a source of truth for the vault key — e.g. the App Store Connect
// .p8 rides the item as an `AuthKey_*.p8` file attachment but its vault key is
// APP_STORE_CONNECT_API__P8_CONTENT, so the mapping is stated explicitly here.
export type SecretCatalogEntry = Readonly<{
  item: string;
  field: string;
  vaultKey: string;
}>;

export type ServiceSecretUsage = Readonly<{
  product: ProductSlug;
  service: string;
  mountPath: "/run/secrets";
  namespaceName: SecretNamespace;
  targetSecretName: string;
  secrets: Readonly<Record<string, SecretCatalogEntry>>;
}>;

export type ControlCenterSecretUsageName = "api" | "worker" | "cloudflared" | "portal-data-purge";

function secret(item: string, field: string, vaultKey: string): SecretCatalogEntry {
  return { item, field, vaultKey };
}

export const secretCatalog = {
  appStoreConnect: {
    keyId: secret("App Store Connect API", "key id", "APP_STORE_CONNECT_API__KEY_ID"),
    issuerId: secret("App Store Connect API", "issuer id", "APP_STORE_CONNECT_API__ISSUER_ID"),
    // The .p8 rides the item as the AuthKey_*.p8 file attachment; in the SOPS
    // vault it is APP_STORE_CONNECT_API__P8_CONTENT (same item CI's fastlane uses).
    p8Content: secret(
      "App Store Connect API",
      "AuthKey_TJ8M46SFSQ.p8",
      "APP_STORE_CONNECT_API__P8_CONTENT",
    ),
  },
  apns: {
    keyId: secret("APNs Auth Key", "key id", "APNS_AUTH_KEY__KEY_ID"),
    teamId: secret("APNs Auth Key", "team id", "APNS_AUTH_KEY__TEAM_ID"),
    // Same shape as appStoreConnect.p8Content: the .p8 rides the item as a file
    // attachment, and the SOPS vault holds it base64-encoded under
    // APNS_AUTH_KEY__P8_CONTENT. pemToPkcs8() accepts armored PEM or bare base64.
    p8Content: secret("APNs Auth Key", "AuthKey_Z8CPKZ46G7.p8", "APNS_AUTH_KEY__P8_CONTENT"),
  },
  captivePortal: {
    postgresPassword: secret(
      "Captive Portal Postgres",
      "password",
      "CAPTIVE_PORTAL_POSTGRES__PASSWORD",
    ),
  },
  cloudflare: {
    // The project-owned `world-wide-webb` tunnel, created by the infra/cloudflare
    // Pulumi stack. Its value is that stack's `managedTunnelToken` output, copied
    // here rather than read via StackReference (the k8s deploy runs in CI, which
    // has no access to the hand-applied cloudflare stack's state).
    managedTunnelToken: secret(
      "Cloudflare Tunnel world-wide-webb",
      "connector_token",
      "CLOUDFLARE_TUNNEL_WORLD_WIDE_WEBB__CONNECTOR_TOKEN",
    ),
  },
  controlCenter: {
    postgresPassword: secret(
      "Control Center Postgres",
      "password",
      "CONTROL_CENTER_POSTGRES__PASSWORD",
    ),
  },
  github: {
    ghcrPat: secret("GitHub Personal Access Token", "token", "GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN"),
  },
  // The www-software-factory-bot GitHub App (#125): the machine identity
  // autonomous agents act as. Minted by the App-manifest flow
  // (scripts/create-github-bot-app.ts) and written by scripts/save-github-bot.sh,
  // so none of these values is ever hand-copied.
  //
  // appId and installationId are identifiers, not secrets, but they live here so
  // the whole credential set has one declaration site. The PEM is stored base64
  // encoded (it is multi-line), the same handling the APNs / App Store Connect
  // .p8 keys already use.
  githubBot: {
    appId: secret("GitHub App www-software-factory-bot", "app_id", "GITHUB_BOT_APP__APP_ID"),
    clientId: secret(
      "GitHub App www-software-factory-bot",
      "client_id",
      "GITHUB_BOT_APP__CLIENT_ID",
    ),
    clientSecret: secret(
      "GitHub App www-software-factory-bot",
      "client_secret",
      "GITHUB_BOT_APP__CLIENT_SECRET",
    ),
    privateKeyPem: secret(
      "GitHub App www-software-factory-bot",
      "private_key_pem",
      "GITHUB_BOT_APP__PRIVATE_KEY_PEM",
    ),
    webhookSecret: secret(
      "GitHub App www-software-factory-bot",
      "webhook_secret",
      "GITHUB_BOT_APP__WEBHOOK_SECRET",
    ),
    installationId: secret(
      "GitHub App www-software-factory-bot",
      "installation_id",
      "GITHUB_BOT_APP__INSTALLATION_ID",
    ),
  },
  homeAssistant: {
    token: secret("Home Assistant Token", "credential", "HOME_ASSISTANT_TOKEN__CREDENTIAL"),
  },
  homeLocation: {
    lat: secret("Home Location", "lat", "HOME_LOCATION__LAT"),
    lon: secret("Home Location", "lon", "HOME_LOCATION__LON"),
    placeName: secret("Home Location", "place_name", "HOME_LOCATION__PLACE_NAME"),
    radiusMiles: secret("Home Location", "radius_miles", "HOME_LOCATION__RADIUS_MILES"),
  },
  spotify: {
    clientId: secret("Spotify", "client_id", "SPOTIFY__CLIENT_ID"),
    clientSecret: secret("Spotify", "client_secret", "SPOTIFY__CLIENT_SECRET"),
    refreshToken: secret("Spotify", "refresh_token", "SPOTIFY__REFRESH_TOKEN"),
  },
  unifi: {
    localApiKey: secret("UniFi", "local_api_key", "UNIFI__LOCAL_API_KEY"),
  },
  withings: {
    clientId: secret("Withings", "client_id", "WITHINGS_CLIENT_ID"),
    clientSecret: secret("Withings", "client_secret", "WITHINGS_CLIENT_SECRET"),
  },
  wifiGuest: {
    password: secret("WiFi Guest Wifi", "password", "WIFI_GUEST_WIFI_PASSWORD"),
    ssid: secret("WiFi Guest Wifi", "ssid", "WIFI_GUEST_WIFI_SSID"),
  },
  wifiMain: {
    ssid: secret("WiFi Main Credentials", "ssid", "WIFI_MAIN_CREDENTIALS__SSID"),
  },
} as const;

export function defineServiceSecretUsage(
  product: ProductIdentity,
  service: string,
  secrets: Readonly<Record<string, SecretCatalogEntry>>,
  options: { targetSecretName?: string; namespaceName?: SecretNamespace } = {},
): ServiceSecretUsage {
  return {
    product: product.slug,
    service,
    mountPath: "/run/secrets",
    namespaceName: options.namespaceName ?? product.namespace,
    targetSecretName: options.targetSecretName ?? `${product.slug}-secrets-${service}`,
    secrets,
  };
}

// Reshape usages into the flat service -> { envName: vaultKey } view infra
// consumes (secrets-map.ts SERVICE_SECRETS). Generic over the usage-key set so
// the caller's literal service keys survive into the result type.
export function serviceSecretMap<K extends string>(
  usages: Readonly<Record<K, ServiceSecretUsage>>,
): Record<K, Record<string, string>> {
  const result = {} as Record<K, Record<string, string>>;
  for (const [service, usage] of Object.entries(usages) as [K, ServiceSecretUsage][]) {
    result[service] = Object.fromEntries(
      Object.entries(usage.secrets).map(([name, entry]) => [name, entry.vaultKey]),
    );
  }
  return result;
}

export function controlCenterServiceSecretUsages(): Record<
  ControlCenterSecretUsageName,
  ServiceSecretUsage
> {
  const controlCenter = defineProduct("control-center");
  // api and worker declare the EXACT SAME secret set today (pinned by
  // secrets.test.ts's "api and worker declare the exact same secret set"
  // test, ADR-0006): both were hand-kept as two ~25-line lockstep blocks that
  // never actually diverged, so a single shared base replaces them. If a
  // future secret is api-only or worker-only, spread this base and add the
  // delta key(s) on the specific service's object instead of both.
  const apiWorkerSharedSecrets = {
    HA_TOKEN: secretCatalog.homeAssistant.token,
    UNIFI_API_KEY: secretCatalog.unifi.localApiKey,
    // Board display SSID is the MAIN network; the guest SSID/password feed the
    // guest Wi-Fi QR only and are never rendered as text (design call 2026-07-19).
    WIFI_SSID: secretCatalog.wifiMain.ssid,
    WIFI_PASSWORD: secretCatalog.wifiGuest.password,
    WIFI_GUEST_SSID: secretCatalog.wifiGuest.ssid,
    POSTGRES_PASSWORD: secretCatalog.controlCenter.postgresPassword,
    HOME_LAT: secretCatalog.homeLocation.lat,
    HOME_LON: secretCatalog.homeLocation.lon,
    HOME_PLACE_NAME: secretCatalog.homeLocation.placeName,
    HOME_RADIUS_MILES: secretCatalog.homeLocation.radiusMiles,
    SPOTIFY_CLIENT_ID: secretCatalog.spotify.clientId,
    SPOTIFY_CLIENT_SECRET: secretCatalog.spotify.clientSecret,
    SPOTIFY_REFRESH_TOKEN: secretCatalog.spotify.refreshToken,
    ASC_KEY_ID: secretCatalog.appStoreConnect.keyId,
    ASC_ISSUER_ID: secretCatalog.appStoreConnect.issuerId,
    ASC_KEY_CONTENT: secretCatalog.appStoreConnect.p8Content,
    // GitHub webhook signature verification (#126). Only the api serves the
    // endpoint, but api/worker secret sets are kept in lockstep (www-51hf.35).
    GITHUB_BOT_WEBHOOK_SECRET: secretCatalog.githubBot.webhookSecret,
    // Deploys-tile poller. Only the worker reads it, but api/worker secret sets
    // are kept in lockstep (www-51hf.35), so it appears in both.
    GITHUB_ACTIONS_TOKEN: secretCatalog.github.ghcrPat,
    // The worker is the only queue consumer, so it is the process that actually
    // signs the APNs JWT and sends the push; api just enqueues. Both still
    // carry the key so the secret sets stay in lockstep.
    APNS_KEY_ID: secretCatalog.apns.keyId,
    APNS_TEAM_ID: secretCatalog.apns.teamId,
    APNS_KEY_CONTENT: secretCatalog.apns.p8Content,
    // Withings direct-API weight ingest. Only the worker polls Withings, but
    // api/worker secret sets are kept in lockstep (see comment above), so it
    // appears in both.
    WITHINGS_CLIENT_ID: secretCatalog.withings.clientId,
    WITHINGS_CLIENT_SECRET: secretCatalog.withings.clientSecret,
  } as const;

  return {
    api: defineServiceSecretUsage(controlCenter, "api", apiWorkerSharedSecrets),
    worker: defineServiceSecretUsage(controlCenter, "worker", apiWorkerSharedSecrets),
    cloudflared: defineServiceSecretUsage(
      controlCenter,
      "cloudflared",
      { TUNNEL_TOKEN: secretCatalog.cloudflare.managedTunnelToken },
      { targetSecretName: "cloudflare-secrets-cloudflared", namespaceName: "cloudflare" },
    ),
    "portal-data-purge": defineServiceSecretUsage(controlCenter, "portal-data-purge", {
      POSTGRES_PASSWORD: secretCatalog.controlCenter.postgresPassword,
    }),
  };
}

// `limits` deliberately has no `cpu` key (only `requests` does) — same
// asymmetry as infra/src/component.ts's ResourceSpec, and for the same reason
// (#87): CPU is compressible, so a CPU limit only throttles under CFS quota
// with no benefit (https://home.robusta.dev/blog/stop-using-cpu-limits),
// while memory is incompressible and needs the limit to bound OOM risk.
// requests.cpu alone gives fair-share scheduling. Do not add a `cpu` field to
// `limits` to "match" requests — the asymmetry is intentional.
export type DatabaseResources = Readonly<{
  limits: Readonly<{ memory: string }>;
  requests: Readonly<{ cpu: string; memory: string }>;
}>;

export type ProductDatabase = Readonly<{
  product: ProductSlug;
  target: ImplementedTargetName;
  clusterName: string;
  databaseName: string;
  owner: string;
  rwServiceName: string;
  roServiceName: string;
  readServiceName: string;
  authSecretName: string;
  auth: Readonly<{
    kind: "database-owned-basic-auth";
    secretName: string;
    password: SecretCatalogEntry;
  }>;
  storageClass: string;
  size: string;
  resources: DatabaseResources;
}>;

export type ProductDatabaseOptions = Readonly<{
  size: string;
  authPassword?: SecretCatalogEntry;
  authSecretName?: string;
  clusterName?: string;
  owner?: string;
  rwServiceName?: string;
  roServiceName?: string;
  readServiceName?: string;
  storageClass?: string;
  resources?: DatabaseResources;
}>;

const defaultDatabaseResources = {
  limits: { memory: "768Mi" },
  requests: { cpu: "500m", memory: "384Mi" },
} as const satisfies DatabaseResources;

function databaseNameFor(product: ProductIdentity): string {
  return product.slug.replaceAll("-", "_");
}

function databasePasswordFor(product: ProductIdentity): SecretCatalogEntry {
  switch (product.slug) {
    case "control-center":
      return secretCatalog.controlCenter.postgresPassword;
    case "captive-portal":
      return secretCatalog.captivePortal.postgresPassword;
  }
  return assertNever(product.slug);
}

export function defineProductDatabase(
  product: ProductIdentity,
  target: HomelabTarget,
  options: ProductDatabaseOptions,
): ProductDatabase {
  const clusterName = options.clusterName ?? "postgres";
  const authSecretName = options.authSecretName ?? "postgres-auth";

  return {
    product: product.slug,
    target: target.name,
    clusterName,
    databaseName: databaseNameFor(product),
    owner: options.owner ?? "postgres",
    rwServiceName: options.rwServiceName ?? `${clusterName}-rw`,
    roServiceName: options.roServiceName ?? `${clusterName}-ro`,
    readServiceName: options.readServiceName ?? `${clusterName}-r`,
    authSecretName,
    auth: {
      kind: "database-owned-basic-auth",
      secretName: authSecretName,
      password: options.authPassword ?? databasePasswordFor(product),
    },
    storageClass: options.storageClass ?? "local-path",
    size: options.size,
    resources: options.resources ?? defaultDatabaseResources,
  };
}

export type DatabaseBackup = Readonly<{
  kind: "postgres-logical-backup";
  required: true;
  product: ProductSlug;
  target: ImplementedTargetName;
  name: string;
  schedule: string;
  image: "ghcr.io/cloudnative-pg/postgresql:18";
  databaseName: string;
  owner: string;
  serviceHost: string;
  authSecretName: string;
  authMountPath: "/run/pgauth";
  backupMountPath: "/backup";
  nasExportPath: string;
  nasSubPath: string;
  filenamePrefix: string;
  // Was the separately-exported `commandFeatures` object (compression/pipefail/
  // passwordSource always the same 3 literals, 0 external consumers, ADR-0006);
  // dateFormat is the only field infra/src/crons.ts actually reads, so it is
  // now a flat field instead of a nested single-shape plurality type.
  dateFormat: "%Y%m%d";
}>;

export type DatabaseBackupOptions = Readonly<{
  name?: string;
  schedule?: string;
  nasSubPathParts?: readonly string[];
}>;

export function defineDatabaseBackup(
  database: ProductDatabase,
  target: HomelabTarget,
  options: DatabaseBackupOptions = {},
): DatabaseBackup {
  const nasSubPathParts = options.nasSubPathParts ?? [
    ...target.nas.backupRootParts,
    database.product,
    "postgres",
  ];

  return {
    kind: "postgres-logical-backup",
    required: true,
    product: database.product,
    target: target.name,
    name: options.name ?? `${database.product}-pg-backup`,
    schedule: options.schedule ?? "0 1 * * *",
    image: "ghcr.io/cloudnative-pg/postgresql:18",
    databaseName: database.databaseName,
    owner: database.owner,
    serviceHost: database.rwServiceName,
    authSecretName: database.authSecretName,
    authMountPath: "/run/pgauth",
    backupMountPath: "/backup",
    nasExportPath: target.nas.exportPath,
    nasSubPath: nasSubPathParts.join("/"),
    filenamePrefix: `${database.databaseName}-`,
    dateFormat: "%Y%m%d",
  };
}

export type ControlCenterServiceName =
  | "api"
  | "worker"
  | "web"
  | "storybook"
  | "captive-portal"
  | "cloudflared";

// Was `{ service, workloadName, image, exposure, secretUsage? }`: workloadName
// and image had 0 external consumers (infra/src/services.ts re-derives both
// independently via ProductIdentity.serviceName/imageRepository, ADR-0006) and
// captivePortalProductManifest() (the only other user of the generic
// ServiceName param) was itself dead, so the type is control-center-only now.
export type ProductServiceDeclaration = Readonly<{
  service: ControlCenterServiceName;
  exposure: WebExposure | InternalServiceExposure | null;
  secretUsage?: ServiceSecretUsage;
}>;

export type ControlCenterProductManifest = Readonly<{
  product: ProductIdentity;
  target: HomelabTarget;
  app: Readonly<{
    exposure: WebExposure;
  }>;
  // The Temporal web UI. Declared here rather than in `services` because it is
  // NOT a control-center workload: it runs in the `temporal` namespace from an
  // upstream image (infra/src/temporal.ts), and `services` drives control-center
  // workload derivation. What it shares with the product is the exposure surface
  // — one hostname, tunnel-routed, Access-gated — so the hostname is owned here,
  // where every other public name in this system is owned.
  temporalUi: Readonly<{
    exposure: WebExposure;
  }>;
  // The Grafana web UI (#209). Same story as `temporalUi` above: not a
  // control-center workload — it runs in the `observability` namespace from an
  // upstream image (infra/src/observability/) — but it does have a hostname on
  // the tunnel behind Access, and hostnames are owned here rather than beside
  // the workload that answers on them.
  grafana: Readonly<{
    exposure: WebExposure;
  }>;
  // The public GitHub webhook host (#126). Served by the api workload, but it
  // is NOT the api's exposure: api stays `internalService` for in-cluster
  // traffic and gains this one public hostname that the tunnel maps to it.
  // Owned here because every other public name in this system is owned here.
  hooks: Readonly<{
    exposure: WebExposure;
  }>;
  services: Readonly<Record<ControlCenterServiceName, ProductServiceDeclaration>>;
  secretUsages: Readonly<Record<ControlCenterSecretUsageName, ServiceSecretUsage>>;
  database: ProductDatabase;
  backup: DatabaseBackup;
}>;

export function controlCenterProductManifest(): ControlCenterProductManifest {
  const product = defineProduct("control-center");
  const target = homelabTarget;
  const secretUsages = controlCenterServiceSecretUsages();
  const database = defineProductDatabase(product, target, {
    authPassword: secretCatalog.controlCenter.postgresPassword,
    authSecretName: "cc-postgres-auth",
    clusterName: "control-center",
    rwServiceName: "control-center-rw",
    roServiceName: "control-center-ro",
    readServiceName: "control-center-r",
    size: "5Gi",
  });
  const backup = defineDatabaseBackup(database, target, {
    name: "pg-backup",
    nasSubPathParts: ["backups", "postgres"],
    schedule: "0 1 * * *",
  });

  return {
    product,
    target,
    app: {
      exposure: privateWeb(target, { host: "app" }),
    },
    temporalUi: {
      // Single label under the zone, so Universal SSL's one-label wildcard
      // covers it (see webHostname).
      exposure: privateWeb(target, { host: "temporal-ui" }),
    },
    grafana: {
      // Single label under the zone, so Universal SSL's one-label wildcard
      // covers it (see webHostname).
      exposure: privateWeb(target, { host: "grafana" }),
    },
    hooks: {
      // PUBLIC on purpose: GitHub posts here from the internet and would be
      // 403'd by Access. Auth is the HMAC in features/hooks/service.ts.
      exposure: publicWeb(target, { host: "hooks" }),
    },
    services: {
      api: {
        service: "api",
        exposure: internalService({ port: 4201 }),
        secretUsage: secretUsages.api,
      },
      worker: {
        service: "worker",
        exposure: null,
        secretUsage: secretUsages.worker,
      },
      web: {
        service: "web",
        exposure: privateWeb(target, { host: "app" }),
      },
      storybook: {
        service: "storybook",
        exposure: privateWeb(target, { host: "storybook" }),
      },
      "captive-portal": {
        service: "captive-portal",
        exposure: captivePortalWeb(target, { host: "app" }),
      },
      cloudflared: {
        service: "cloudflared",
        exposure: null,
        secretUsage: secretUsages.cloudflared,
      },
    },
    secretUsages,
    database,
    backup,
  };
}
