// The scheduled jobs for the control-center k3s stack (www-j934.7): the cronJob()
// declarations for the cluster. map-extract is re-homed verbatim and pg-backup
// is NEW; every retention purge (portal/weather/felogs/wakes/github) now runs
// through the generated S2 seam (generatedCronSpecs() below) — the legacy
// hand-wired "portal-data-purge" CronJob (bundled purge.js one-shot) is retired.
//
// Deliberately ABSENT vs the prior scheduler set (DESIGN.md §2):
//  - docker-image-prune: kubelet image GC replaces it (high 85% / low 80%); an
//    external `docker image prune` breaks kubelet's image accounting (RECON
//    decision 7), so NO image-prune CronJob exists on k3s.
//  - portal-cert-renew: the acme.sh cron is retired; cert-manager owns the portal
//    TLS Certificate + its renewal window (www-j934.5), nothing to schedule here.
//
// Each cron is a CronJobSpec fed to the ScheduledJob component (component.ts),
// which renders the k8s CronJob with one-shot semantics (Forbid + Never). The
// pure declaration lives here; the Pulumi instantiation is the thin wrapper.

import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { controlCenterProductManifest, type DatabaseBackup, defineProduct } from "@www/platform";
import { GENERATED_CRONS } from "../../features/_generated/crons.gen.ts";
import type { InfraNamespaceName } from "./cluster.ts";
import type { CronJobSpec } from "./component.ts";
import { ScheduledJob } from "./component.ts";
import { GHCR_PULL_SECRET_NAME } from "./ghcr-pull-secrets.ts";
import { SERVICE_SECRET_TARGETS } from "./secrets-map.ts";

export type OwnedCronJobSpec = CronJobSpec & { namespaceName: InfraNamespaceName };

const controlCenterProduct = defineProduct("control-center");

// GHCR image ref (mutable :main tag; CI digest-pins at deploy). Mirrors services.ts.
const ghcr = (name: string) => `${controlCenterProduct.imageRepository(name)}:main`;

const TZ = "America/Los_Angeles";

function postgresBackupCommand(backup: DatabaseBackup): string[] {
  return [
    // bash, NOT sh: the image's /bin/sh is dash, which lacks `set -o pipefail`
    // (the cloudnative-pg image is Debian-based and ships bash).
    "bash",
    "-c",
    [
      // pipefail is REQUIRED: pg_dump pipes into gzip, so without it a pg_dump
      // failure (e.g. a server-version mismatch) is masked by gzip's success and
      // the job writes a broken/empty artifact while reporting Complete. With
      // pipefail (+ errexit) the failed dump fails the job, so a bad backup is
      // never silently "successful".
      "set -eo pipefail",
      `export PGPASSWORD="$(cat ${backup.authMountPath}/password)"`,
      `out="${backup.backupMountPath}/${backup.filenamePrefix}$(date +${backup.dateFormat}).sql.gz"`,
      `pg_dump -h ${backup.serviceHost} -U ${backup.owner} -d ${backup.databaseName} | gzip -c > "$out"`,
      'echo "wrote $out"',
    ].join("\n"),
  ];
}

/**
 * @public - adapts the platform product backup intent into the infra CronJob
 * vocabulary while keeping renderCronJob responsible for k8s object details.
 */
export function postgresBackupCronSpec(
  backup: DatabaseBackup,
  nasNfsServer: string,
): OwnedCronJobSpec {
  return {
    name: backup.name,
    // DatabaseBackup.product is the full platform ProductSlug (still includes
    // "captive-portal", kept alive in @www/platform until Task 7+8), but
    // InfraNamespaceName deliberately excludes it post-Task-6 (its namespace
    // is gone). This adapter stays generic over any product's backup , the
    // real deploy path (crons.ts's own cronSpecs()) only ever feeds it
    // control-center's backup now.
    namespaceName: backup.product as InfraNamespaceName,
    image: backup.image,
    schedule: backup.schedule,
    command: postgresBackupCommand(backup),
    env: { TZ },
    extraSecretMounts: [{ secretName: backup.authSecretName, mountPath: backup.authMountPath }],
    volumes: [
      {
        mountPath: backup.backupMountPath,
        nfs: { server: nasNfsServer, path: backup.nasExportPath },
        subPath: backup.nasSubPath,
      },
    ],
  };
}

// The shared NAS backup root every product's backups live under (mirrors
// @www/platform's homelabTarget.nas , not imported directly because
// home-assistant is deliberately NOT a @www/platform ProductSlug (Task 4: its
// CNPG cluster is self-contained in homeassistant.ts, not the closed
// ProductDatabase/DatabaseBackup union). Kept as a literal string constant
// here so it can't silently drift from the platform value without a reviewer
// noticing the duplication.
const NAS_BACKUP_ROOT = "backups/world-wide-webb";

/**
 * @public - the `ha-config` PVC's daily backup: tars `.storage` + the YAML
 * config files (NOT the recorder history, which lives in the separate
 * `home_assistant` CNPG cluster below and is backed up via pg_dump instead ,
 * see homeAssistantPgBackupCronSpec). Mirrors postgresBackupCronSpec's NFS
 * destination pattern. Talos-only: consumed by homeassistant.ts, itself only
 * invoked from program.ts behind `substrate === "talos"`.
 */
export function haConfigBackupCronSpec(args: {
  nasNfsServer: string;
  haConfigClaimName: string;
}): CronJobSpec {
  const { nasNfsServer, haConfigClaimName } = args;
  const backupMountPath = "/backup";
  return {
    name: "ha-config-backup",
    image: "alpine:3.20",
    schedule: "15 1 * * *",
    // alpine's /bin/sh is busybox ash (no `pipefail`), and this command has no
    // pipe , plain `set -e` is sufficient and correct here, unlike
    // postgresBackupCommand's pg_dump-into-gzip pipe.
    command: [
      "sh",
      "-c",
      [
        "set -e",
        "cd /config",
        `out="${backupMountPath}/ha-config-$(date +%Y%m%d).tar.gz"`,
        // `.storage` (registries, auth, tokens) + top-level YAML (configuration/
        // automations/scripts/etc). Recorder history is NOT here (§0.3): it lives
        // entirely in the home_assistant CNPG cluster, backed up separately below.
        'tar -czf "$out" .storage *.yaml',
        'echo "wrote $out"',
      ].join("\n"),
    ],
    env: { TZ },
    volumes: [
      // Read-only: this cron only ever reads the live config, never writes it.
      { mountPath: "/config", claim: haConfigClaimName, readOnly: true },
      {
        mountPath: backupMountPath,
        nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
        subPath: `${NAS_BACKUP_ROOT}/home-assistant/ha-config`,
      },
    ],
  };
}

/**
 * @public - the `home_assistant` CNPG cluster's daily pg_dump, alongside
 * control-center's (Step 6b): keeps the backup pattern uniform across every
 * Postgres cluster in the stack even though this data is disposable (§0.1 ,
 * no recorder history is migrated from the mini). Talos-only: consumed by
 * homeassistant.ts.
 */
export function homeAssistantPgBackupCronSpec(args: {
  nasNfsServer: string;
  serviceHost: string;
  databaseName: string;
  owner: string;
  authSecretName: string;
}): CronJobSpec {
  const { nasNfsServer, serviceHost, databaseName, owner, authSecretName } = args;
  const authMountPath = "/run/pgauth";
  const backupMountPath = "/backup";
  return {
    name: "home-assistant-pg-backup",
    // Same CNPG-provided pg_dump/pg_restore-compatible image as
    // control-center's backup, so both crons share one bash-based image (not
    // Debian's dash /bin/sh) for `set -o pipefail`.
    image: "ghcr.io/cloudnative-pg/postgresql:18",
    schedule: "0 1 * * *",
    command: [
      "bash",
      "-c",
      [
        "set -eo pipefail",
        `export PGPASSWORD="$(cat ${authMountPath}/password)"`,
        `out="${backupMountPath}/${databaseName}-$(date +%Y%m%d).sql.gz"`,
        `pg_dump -h ${serviceHost} -U ${owner} -d ${databaseName} | gzip -c > "$out"`,
        'echo "wrote $out"',
      ].join("\n"),
    ],
    env: { TZ },
    extraSecretMounts: [{ secretName: authSecretName, mountPath: authMountPath }],
    volumes: [
      {
        mountPath: backupMountPath,
        nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
        subPath: `${NAS_BACKUP_ROOT}/home-assistant/postgres`,
      },
    ],
  };
}

const controlCenterManifest = controlCenterProductManifest();
const controlCenterBackup = controlCenterManifest.backup;
const controlCenterPostgresHost = controlCenterManifest.database.rwServiceName;
// captive-portal's backup CronJob REMOVED (SDD track 0, Task 6) along with
// its CNPG clusters + namespace; a final pg_dump was taken to the NAS first
// (captive-portal-final-20260721.dump).

// One k8s CronJob per collected defineCron facet (S2 seam). Each runs the api
// image's generic cron dispatcher (`bun cron.js <name>`), which invokes the
// feature's run() via cron-handlers.gen.ts. Replaces per-cron hand-wiring: a new
// purge-bearing feature declares defineCron and appears here automatically.
function generatedCronSpecs(): OwnedCronJobSpec[] {
  return GENERATED_CRONS.map((c) => ({
    name: c.name,
    namespaceName: "control-center",
    image: ghcr("api"),
    schedule: c.schedule,
    command: ["bun", "cron.js", c.name],
    secrets: [{ name: "POSTGRES_PASSWORD", ref: "eso" }],
    // "portal-data-purge" is now a pure secret-name label (its CronJob was
    // retired) — kept as the shared POSTGRES_PASSWORD secret-target key for
    // every generated cron. Do NOT rename/remove this key: secrets-map.ts is
    // out of scope for this fold, and every generated cron's secret depends on it.
    secretName: SERVICE_SECRET_TARGETS["portal-data-purge"].secretName,
    // NODE_ENV/APP_ENV must be "production" here (mirrors haEnv in services.ts):
    // the env registry's DATABASE_URL devDefault (localhost) only yields to the
    // secret-derived DATABASE_URL when APP_ENV === "production" — see issue #27.
    env: {
      TZ,
      POSTGRES_HOST: controlCenterPostgresHost,
      NODE_ENV: "production",
      APP_ENV: "production",
    },
    imagePullSecrets: [GHCR_PULL_SECRET_NAME],
  }));
}

/**
 * @public - the declared CronJob set (pure data). nasNfsServer is threaded into
 * the pg-backup NFS PV the same way services.ts threads it into the worker
 * (www-j934.17); the NAS LAN IP by default. Consumed by deployCrons + the unit
 * tests; no other internal consumer.
 */
export function cronSpecs(nasNfsServer: string): OwnedCronJobSpec[] {
  return [
    // One CronJob per collected defineCron facet (S2 seam), e.g. guest-wifi's
    // guest-wifi-purge. Runs the api image's generic `bun cron.js <name>`
    // dispatcher. New purge-bearing features appear here automatically with
    // zero hand-wiring.
    ...generatedCronSpecs(),

    // Tesla-map basemap refresher (www-gma → www-hn1i). Runs the in-repo
    // map-provision image in FORCE mode: resolve the newest Protomaps planet
    // build at runtime (their daily builds are deleted after ~7 days, so any
    // hardcoded date rots, the original suspended/manual recipe pinned one and
    // prod shipped with an empty maps PVC), extract the SoCal bbox, atomically
    // rename into the `maps` PVC the web service serves /maps/*.pmtiles from.
    // Monthly is plenty (street data drifts slowly); first-provision on a fresh
    // stack is the web pod's map-provision initContainer, NOT this cron. Ad-hoc
    // refresh: `kubectl create job --from=cronjob/map-extract <name>`.
    {
      name: "map-extract",
      namespaceName: "control-center",
      image: ghcr("map-provision"),
      schedule: "23 5 3 * *",
      command: ["/provision.sh", "force"],
      env: { TZ },
      volumes: [{ mountPath: "/out", claim: "maps" }],
      // A NEW GHCR package is born private on first push; without the pull
      // secret the first scheduled run ImagePullBackOffs (www-hn1i).
      imagePullSecrets: [GHCR_PULL_SECRET_NAME],
    },

    // Control Center stays on the compatibility backup path until that live path
    // migration gets explicit review. New product backups use the platform path.
    postgresBackupCronSpec(controlCenterBackup, nasNfsServer),
  ];
}

export interface CronsArgs {
  provider: k8s.Provider;
  namespaces: Readonly<Record<InfraNamespaceName, pulumi.Input<string>>>;
  // NFS server for the NAS backup PV; the NAS LAN IP by default. kubelet mounts
  // the PV from the node netns (reaches the LAN on homelab, DESIGN §5b); the
  // pod-egress no-route limit (§5c) does not apply to PV mounts. www-j934.17.
  nasNfsServer: string;
}

export interface CronsResources {
  jobs: ScheduledJob[];
}

/**
 * @public - instantiates a ScheduledJob per declared cron. Consumed by the
 * cluster program (program.ts); no other internal consumer in this ticket.
 */
export function deployCrons(args: CronsArgs): CronsResources {
  const { provider, namespaces, nasNfsServer } = args;
  const jobs = cronSpecs(nasNfsServer).map(
    ({ namespaceName, ...spec }) =>
      new ScheduledJob({ ...spec, provider, namespace: namespaces[namespaceName] }, { provider }),
  );
  return { jobs };
}
