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
  VISIBILITY_DATABASE_NAME as TEMPORAL_VISIBILITY_DATABASE_NAME,
} from "./temporal.ts";

export const DB_UI_NAMESPACE = "db-ui";

const IMAGE = "dpage/pgadmin4:9.4";
const PORT = 80;
const DATA_CLAIM_NAME = "pgadmin-data";
const DATA_CLAIM_SIZE = "1Gi";
const CONFIG_MAP_NAME = "db-ui-servers";
const PGPASS_SECRET_NAME = "db-ui-pgpass";
const LOGIN_SECRET_NAME = "db-ui-login";
const PGPASS_MOUNT_DIR = "/pgpass";
const PGPASS_FILE_PATH = `${PGPASS_MOUNT_DIR}/pgpass`;

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
  // Temporal's visibility store gets its own tree entry (same host/creds,
  // different MaintenanceDB) so it's directly clickable rather than reached
  // by manually retyping the database name after connecting.
  const temporalIndex = dbTargets.findIndex((t) => t.name === "temporal");
  if (temporalIndex !== -1) {
    const temporal = dbTargets[temporalIndex];
    servers[String(dbTargets.length + 1)] = {
      Name: "temporal-visibility",
      Group: "Servers",
      Host: temporal.host,
      Port: 5432,
      MaintenanceDB: TEMPORAL_VISIBILITY_DATABASE_NAME,
      Username: temporal.owner,
      PassFile: PGPASS_FILE_PATH,
      SSLMode: "prefer",
    };
  }
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
        email: "db-ui-admin@worldwidewebb.co",
        password: pulumi.secret(pgAdminPassword),
      },
    },
    inNamespace,
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
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            // dpage/pgadmin4's documented non-root uid/gid for /var/lib/pgadmin
            // bind mounts. NOT verified against this exact image tag's actual
            // runtime user — if the container in fact runs as root (its
            // common default), this is an inert no-op; if it runs as uid 5050,
            // this is required for the PVC. Either way, note the pgpass
            // Secret below is mode 0600 (owner-only, per libpq's OWN
            // passfile-permission check), so fsGroup membership alone does
            // NOT grant a non-root, non-owning process read access to it —
            // only a literal root process can read a 0600 root-owned file.
            // Verify pgAdmin can actually authenticate against all 3 servers
            // after deploy; if not, this is the first place to look.
            securityContext: { fsGroup: 5050 },
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
                resources: {
                  limits: { memory: "256Mi" },
                  requests: { cpu: "50m", memory: "128Mi" },
                },
              },
            ],
            volumes: [
              { name: "servers-config", configMap: { name: CONFIG_MAP_NAME } },
              // 0600: libpq's pgpass permission check applies to explicit
              // PassFile paths too, not just the default ~/.pgpass.
              { name: "pgpass", secret: { secretName: PGPASS_SECRET_NAME, defaultMode: 0o600 } },
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
