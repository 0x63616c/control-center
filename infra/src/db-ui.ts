// pgAdmin4, hand-written, the same shape as temporal.ts's temporal-ui: a
// declarative multi-database web SQL/GUI client for the 3 CNPG Postgres
// clusters already in the stack (control-center, home-assistant, temporal),
// reachable at db-ui.worldwidewebb.co (issue #65).
//
// Why pgAdmin over CloudBeaver/Adminer/Metabase: its connection list can be
// fully pre-seeded from a checked-in servers.json + a Pulumi-composed pgpass
// file, so there is nothing to reclick through an admin UI after a redeploy —
// this repo already learned that lesson the hard way with Drizzle Gateway
// (drizzle.worldwidewebb.co), which rotted at `replicas: 0` and was deleted in
// 100fa3f7e specifically because its config lived nowhere but the running pod.
//
// Credentials: this module reads the SAME vault keys the three clusters'
// owning modules already use (cnpg.ts, homeassistant.ts, temporal.ts) — it
// mints NO new database credentials, it composes one extra Secret (a pgpass
// file) in ITS OWN namespace from passwords Pulumi already has decrypted in
// memory. No cross-namespace Secret reads.
//
// TALOS-ONLY: a no-op unless installDbUi() is called, which program.ts only
// does behind `substrate === "talos"`.

import { createHash } from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { controlCenterProductManifest } from "@www/platform";
import {
  DATABASE_NAME as HOME_ASSISTANT_DATABASE_NAME,
  HOME_ASSISTANT_NAMESPACE,
  DATABASE_OWNER as HOME_ASSISTANT_OWNER,
  CNPG_RW_SERVICE_NAME as HOME_ASSISTANT_RW_SERVICE_NAME,
} from "./homeassistant.ts";
import {
  DATABASE_NAME as TEMPORAL_DATABASE_NAME,
  TEMPORAL_NAMESPACE,
  CNPG_RW_SERVICE_NAME as TEMPORAL_RW_SERVICE_NAME,
} from "./temporal.ts";

export const DB_UI_NAMESPACE = "db-ui";

const IMAGE = "dpage/pgadmin4:9.16";
const PORT = 80;
const DATA_CLAIM_NAME = "pgadmin-data";
const DATA_CLAIM_SIZE = "1Gi";
const CONFIG_MAP_NAME = "db-ui-servers";
const PGPASS_SECRET_NAME = "db-ui-pgpass";
const LOGIN_SECRET_NAME = "db-ui-login";
// pgAdmin's own local login identity (NOT a real mailbox — see loginSecret
// below). Fixed, not vault-sourced: it's just a string key, and the storage
// path below is derived from it.
const LOGIN_EMAIL = "db-ui-admin@worldwidewebb.co";
// The value handed to pgAdmin's `PassFile` connection param. In SERVER_MODE
// (the web/container build, which is what this is), pgAdmin does NOT treat
// this as a real filesystem path: `get_complete_file_path()`
// (pgadmin/utils/__init__.py) strips the leading slash and re-joins it under
// that user's private file-manager storage root,
// `/var/lib/pgadmin/storage/<sanitized-login-email>/`, then checks
// `os.path.isfile()` on THAT path — silently falling back to a password
// prompt if it doesn't exist there. (Confirmed live 2026-07-26 against a
// deployed pod: the naive `/pgpass/pgpass` mount from the first cut of this
// module never resolved, and every connect prompted for a password.) The
// sanitization is `email.replace("@", "_")` (pgadmin/utils/paths.py
// preprocess_username) — LOGIN_EMAIL has no "/" or "\", so that's the only
// transform that applies here.
const PGPASS_FILE_PATH = "/pgpass/pgpass";
const PGADMIN_STORAGE_USER = LOGIN_EMAIL.replace("@", "_");
const PGPASS_MOUNT_DIR = `/var/lib/pgadmin/storage/${PGADMIN_STORAGE_USER}/pgpass`;

const labels = { app: "db-ui" };

/**
 * One row per reachable database, fully qualified so it resolves across the
 * cluster-DNS namespace boundary (this pod lives in `db-ui`, none of the 3
 * targets do).
 */
interface DbUiTarget {
  name: string;
  host: string;
  database: string;
  owner: string;
  password: string;
}

function targets(vault: Record<string, string>): DbUiTarget[] {
  const cc = controlCenterProductManifest().database;
  const ccPassword = vault.CONTROL_CENTER_POSTGRES__PASSWORD;
  const haPassword = vault.HOME_ASSISTANT_POSTGRES__PASSWORD;
  const temporalPassword = vault.TEMPORAL_POSTGRES__PASSWORD;
  if (ccPassword === undefined) {
    throw new Error("db-ui: vault key CONTROL_CENTER_POSTGRES__PASSWORD not found");
  }
  if (haPassword === undefined) {
    throw new Error("db-ui: vault key HOME_ASSISTANT_POSTGRES__PASSWORD not found");
  }
  if (temporalPassword === undefined) {
    throw new Error("db-ui: vault key TEMPORAL_POSTGRES__PASSWORD not found");
  }
  return [
    {
      name: "control-center",
      host: `${cc.rwServiceName}.control-center.svc.cluster.local`,
      database: cc.databaseName,
      owner: cc.owner,
      password: ccPassword,
    },
    {
      name: "home-assistant",
      host: `${HOME_ASSISTANT_RW_SERVICE_NAME}.${HOME_ASSISTANT_NAMESPACE}.svc.cluster.local`,
      database: HOME_ASSISTANT_DATABASE_NAME,
      owner: HOME_ASSISTANT_OWNER,
      password: haPassword,
    },
    {
      // One row covers both `temporal` and `temporal_visibility` — pgpass
      // matches by host:port:user regardless of the `database` field, and the
      // `postgres` superuser can reach both; servers.json below lists both
      // databases as separate tree entries against this one row.
      name: "temporal",
      host: `${TEMPORAL_RW_SERVICE_NAME}.${TEMPORAL_NAMESPACE}.svc.cluster.local`,
      database: TEMPORAL_DATABASE_NAME,
      owner: "postgres",
      password: temporalPassword,
    },
  ];
}

/**
 * `.pgpass` format: hostname:port:database:username:password, `*` wildcards
 * the database column so one line covers every database on that host (needed
 * for temporal + temporal_visibility). Colons/backslashes in passwords must be
 * escaped per the libpq pgpass spec — vault passwords here are base64, which
 * cannot contain either, so this is defensive rather than load-bearing today.
 */
function pgpassEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function pgpassLine(target: DbUiTarget): string {
  return `${target.host}:5432:*:${pgpassEscape(target.owner)}:${pgpassEscape(target.password)}`;
}

function serversJson(dbTargets: DbUiTarget[]): string {
  // One tree entry per Postgres INSTANCE, not per database: pgAdmin already
  // lists every database the connected user can see under a server's own
  // Databases node, so `temporal_visibility` shows up there once connected to
  // `temporal` — a separate "temporal-visibility" server would point at the
  // exact same host/instance and just be a redundant duplicate entry.
  const servers = Object.fromEntries(
    dbTargets.map((target, index) => [
      String(index + 1),
      {
        Name: target.name,
        Group: "Servers",
        Host: target.host,
        Port: 5432,
        MaintenanceDB: target.database,
        Username: target.owner,
        PassFile: PGPASS_FILE_PATH,
        SSLMode: "prefer",
      },
    ]),
  );
  return JSON.stringify({ Servers: servers }, null, 2);
}

export interface DbUiArgs {
  provider: k8s.Provider;
  // Decrypted vault (vault.ts). Needs CONTROL_CENTER_POSTGRES__PASSWORD,
  // HOME_ASSISTANT_POSTGRES__PASSWORD, TEMPORAL_POSTGRES__PASSWORD (all
  // already minted for their owning clusters) plus PGADMIN__PASSWORD (pgAdmin's
  // own master login, unique to this module).
  vault: Record<string, string>;
}

export interface DbUiResources {
  namespace: k8s.core.v1.Namespace;
  serversConfigMap: k8s.core.v1.ConfigMap;
  pgpassSecret: k8s.core.v1.Secret;
  loginSecret: k8s.core.v1.Secret;
  dataClaim: k8s.core.v1.PersistentVolumeClaim;
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
}

/**
 * @public - installs the db-ui namespace and a single pgAdmin4 pod
 * pre-configured with the 3 CNPG clusters. Consumed by program.ts, gated to
 * the "talos" substrate.
 */
export function installDbUi(args: DbUiArgs): DbUiResources {
  const { provider, vault } = args;
  const opts = { provider };

  const pgAdminPassword = vault.PGADMIN__PASSWORD;
  if (pgAdminPassword === undefined) {
    throw new Error("db-ui: vault key PGADMIN__PASSWORD not found");
  }

  const namespace = new k8s.core.v1.Namespace(
    DB_UI_NAMESPACE,
    { metadata: { name: DB_UI_NAMESPACE } },
    opts,
  );
  const namespaceName = namespace.metadata.name;
  const inNamespace = { ...opts, dependsOn: [namespace] };

  const dbTargets = targets(vault);

  const serversConfigMap = new k8s.core.v1.ConfigMap(
    CONFIG_MAP_NAME,
    {
      metadata: { name: CONFIG_MAP_NAME, namespace: namespaceName },
      data: { "servers.json": serversJson(dbTargets) },
    },
    inNamespace,
  );

  const pgpassSecret = new k8s.core.v1.Secret(
    PGPASS_SECRET_NAME,
    {
      metadata: { name: PGPASS_SECRET_NAME, namespace: namespaceName },
      stringData: {
        pgpass: pulumi.secret(`${dbTargets.map(pgpassLine).join("\n")}\n`),
      },
    },
    inNamespace,
  );

  // pgAdmin's own login gate (in addition to Cloudflare Access's email-OTP in
  // front of it — see infra/cloudflare/src/access.ts, which is what actually
  // authenticates the human). This login is just a local pgAdmin identity, not
  // a real mailbox — single admin identity, single-operator internal tool.
  const loginSecret = new k8s.core.v1.Secret(
    LOGIN_SECRET_NAME,
    {
      metadata: { name: LOGIN_SECRET_NAME, namespace: namespaceName },
      stringData: {
        email: LOGIN_EMAIL,
        password: pulumi.secret(pgAdminPassword),
      },
    },
    inNamespace,
  );

  // Forces a pod restart whenever servers.json/pgpass/login content changes.
  // Neither a ConfigMap volume mount nor a Secret env var (secretKeyRef) is
  // re-read by a running pod — plain kubectl/Pulumi apply just updates the
  // object, leaving the live pod on stale content until something else
  // restarts it. Folding a hash of that content into the pod template forces
  // Kubernetes to see a spec diff and roll the deployment. (This is what
  // silently broke db-ui after the control-center-postgres cutover, #111.)
  const configChecksum = pulumi
    .all([serversConfigMap.data, pgpassSecret.stringData, loginSecret.stringData])
    .apply(([serversData, pgpassData, loginData]) =>
      createHash("sha256")
        .update(JSON.stringify({ serversData, pgpassData, loginData }))
        .digest("hex"),
    );

  const dataClaim = new k8s.core.v1.PersistentVolumeClaim(
    DATA_CLAIM_NAME,
    {
      metadata: { name: DATA_CLAIM_NAME, namespace: namespaceName },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "local-path",
        // pgAdmin's own prefs/session sqlite db only (query history, saved
        // filters) — never query result data, so this stays tiny forever.
        resources: { requests: { storage: DATA_CLAIM_SIZE } },
      },
    },
    inNamespace,
  );

  const deployment = new k8s.apps.v1.Deployment(
    "db-ui",
    {
      metadata: { name: "db-ui", namespace: namespaceName, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels, annotations: { "checksum/config": configChecksum } },
          spec: {
            automountServiceAccountToken: false,
            // Verified live (2026-07-26): libpq's OWN pgpass permission check
            // (fe-connect.c) unconditionally rejects any file with group OR
            // world bits set — it inspects the mode bits alone, not whether the
            // reading process happens to satisfy them. Kubernetes Secret
            // volumes can't produce a bare 0600 (owner-only, no group bits) the
            // moment a pod sets `fsGroup` (needed at all for this image's
            // non-root uid 5050 to read a Secret volume): kubelet always ORs in
            // group-read once fsGroup applies, landing at 0640 — which libpq
            // then silently refuses, falling back to a password prompt. Fixed
            // by copying the Secret into an emptyDir via a root initContainer
            // and chmod-ing it there, where we control the exact bits and can
            // chown straight to uid 5050 instead of relying on group access.
            initContainers: [
              {
                name: "pgpass-init",
                image: "busybox:1.36",
                command: [
                  "sh",
                  "-c",
                  `cp /pgpass-secret/pgpass ${PGPASS_MOUNT_DIR}/pgpass && chown 5050:5050 ${PGPASS_MOUNT_DIR}/pgpass && chmod 600 ${PGPASS_MOUNT_DIR}/pgpass`,
                ],
                volumeMounts: [
                  { name: "pgpass-secret", mountPath: "/pgpass-secret" },
                  { name: "pgpass", mountPath: PGPASS_MOUNT_DIR },
                ],
              },
            ],
            containers: [
              {
                name: "pgadmin",
                image: IMAGE,
                env: [
                  {
                    name: "PGADMIN_DEFAULT_EMAIL",
                    valueFrom: { secretKeyRef: { name: LOGIN_SECRET_NAME, key: "email" } },
                  },
                  {
                    name: "PGADMIN_DEFAULT_PASSWORD",
                    valueFrom: { secretKeyRef: { name: LOGIN_SECRET_NAME, key: "password" } },
                  },
                  { name: "PGADMIN_LISTEN_PORT", value: String(PORT) },
                  { name: "PGADMIN_SERVER_JSON_FILE", value: "/pgadmin4/servers.json" },
                  // pgAdmin only imports servers.json on a FRESH config db —
                  // once /var/lib/pgadmin has state from a prior boot it never
                  // re-reads this file. That's fine here: the 3 clusters don't
                  // change shape often, and doing so is a redeploy of this
                  // Deployment (new pod, same PVC) not a config-drift risk,
                  // since the PVC only holds prefs/session state, not the
                  // server list's source of truth (this file).
                ],
                ports: [{ name: "http", containerPort: PORT }],
                volumeMounts: [
                  {
                    name: "servers-config",
                    mountPath: "/pgadmin4/servers.json",
                    subPath: "servers.json",
                  },
                  { name: "pgpass", mountPath: PGPASS_MOUNT_DIR },
                  { name: "data", mountPath: "/var/lib/pgadmin" },
                ],
                // 256Mi OOMKilled 9.16 on boot (confirmed live 2026-07-26) — the
                // 9.4 pin this was sized against was lighter. 512Mi/256Mi is
                // still trivial next to the rest of this cluster's workloads.
                resources: {
                  limits: { memory: "512Mi" },
                  requests: { cpu: "50m", memory: "256Mi" },
                },
              },
            ],
            volumes: [
              { name: "servers-config", configMap: { name: CONFIG_MAP_NAME } },
              { name: "pgpass-secret", secret: { secretName: PGPASS_SECRET_NAME } },
              // Populated by the pgpass-init initContainer above, not mounted
              // straight from the Secret — see that container's comment.
              { name: "pgpass", emptyDir: {} },
              { name: "data", persistentVolumeClaim: { claimName: DATA_CLAIM_NAME } },
            ],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [serversConfigMap, pgpassSecret, loginSecret, dataClaim] },
  );

  const service = new k8s.core.v1.Service(
    "db-ui",
    {
      metadata: { name: "db-ui", namespace: namespaceName, labels },
      spec: {
        type: "ClusterIP",
        selector: labels,
        ports: [{ name: "http", port: PORT, targetPort: PORT }],
      },
    },
    inNamespace,
  );

  return { namespace, serversConfigMap, pgpassSecret, loginSecret, dataClaim, deployment, service };
}
