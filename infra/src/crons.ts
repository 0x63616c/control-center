// The scheduled jobs for the control-center k3s stack (www-j934.7): the cronJob()
// declarations for the cluster. Only infra-level work remains here: map-extract
// (separate map-provision image) and the pg/HA backups. Every retention purge
// migrated to Temporal Schedules declared from feature facets (ADR-0008, issue
// #260) — the whole generated-cron seam (crons.gen.ts + `bun cron.js <name>`)
// is deleted.
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
import {
  controlCenterProductManifest,
  type DatabaseBackup,
  defineProduct,
  softwareFactoryProductManifest,
} from "@www/platform";
import type { InfraNamespaceName } from "./cluster.ts";
import type { CronJobSpec } from "./component.ts";
import { ScheduledJob } from "./component.ts";
import { GHCR_PULL_SECRET_NAME } from "./ghcr-pull-secrets.ts";

export type OwnedCronJobSpec = CronJobSpec & { namespaceName: InfraNamespaceName };

const controlCenterProduct = defineProduct("control-center");

// Per-image digest pins, name -> "sha256:…" (same shape/source as services.ts's
// ImageDigests: CI's deploy job writes these via `pulumi config set --path
// imageDigests.<svc>`). Digest-pinned (@sha256:…) when supplied, else the
// mutable :main tag. This MUST match services.ts's Deployments: a CronJob pod
// runs with imagePullPolicy: IfNotPresent, so a plain :main tag never re-pulls
// once a node has any :main layer cached — every purge CronJob silently kept
// running whatever image first landed on the node regardless of new pushes
// (issue #27's second half: the boot-env fix alone couldn't reach a running
// pod until this pinning existed).
export type ImageDigests = Record<string, string>;

const ghcr = (name: string, digests: ImageDigests = {}): string => {
  const repository = controlCenterProduct.imageRepository(name);
  const digest = digests[controlCenterProduct.imageDigestKey(name)];
  return digest ? `${repository}@${digest}` : `${repository}:main`;
};

const TZ = "America/Los_Angeles";

interface PostgresBackupCommandArgs {
  authMountPath: string;
  backupMountPath: string;
  filenamePrefix: string;
  dateFormat: string;
  serviceHost: string;
  owner: string;
  databaseName: string;
}

function postgresBackupCommand({
  authMountPath,
  backupMountPath,
  filenamePrefix,
  dateFormat,
  serviceHost,
  owner,
  databaseName,
}: PostgresBackupCommandArgs): string[] {
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
      `export PGPASSWORD="$(cat ${authMountPath}/password)"`,
      `out="${backupMountPath}/${filenamePrefix}$(date +${dateFormat}).sql.gz"`,
      'tmp="$out.tmp"',
      'rm -f "$tmp"',
      // The sibling temporary file keeps publication on the backup mount, so
      // this rename atomically replaces the date-named artifact.
      "trap 'rm -f \"$tmp\"' EXIT",
      `pg_dump -h ${serviceHost} -U ${owner} -d ${databaseName} | gzip -c > "$tmp"`,
      'gzip -t "$tmp"',
      'mv "$tmp" "$out"',
      "trap - EXIT",
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
    // real deploy path feeds it only product backups with namespaces.
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

// Payload blobs are primary data, unlike discardable stage transcripts. This
// takes a nightly, atomically published archive to the product backup tree.
// It mounts the NAS paths directly rather than the blobs PVC, preserving the
// service-only PVC mount boundary declared in software-factory.ts.
function softwareFactoryBlobsBackupCronSpec(nasNfsServer: string): OwnedCronJobSpec {
  const sourceMountPath = "/source";
  const backupMountPath = "/backup";
  return {
    name: "software-factory-blobs-backup",
    namespaceName: "software-factory",
    image: "alpine:3.20",
    schedule: "30 1 * * *",
    command: [
      "sh",
      "-c",
      [
        "set -e",
        `out="${backupMountPath}/blobs-$(date +%Y%m%d).tar.gz"`,
        'tmp="$out.tmp"',
        'rm -f "$tmp"',
        `tar -C ${sourceMountPath} -czf "$tmp" .`,
        'mv "$tmp" "$out"',
        'echo "wrote $out"',
      ].join("\n"),
    ],
    env: { TZ },
    volumes: [
      {
        mountPath: sourceMountPath,
        nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
        readOnly: true,
        subPath: "software-factory/blobs",
      },
      {
        mountPath: backupMountPath,
        nfs: { server: nasNfsServer, path: "/volume1/Homelab" },
        subPath: `${NAS_BACKUP_ROOT}/software-factory/blobs`,
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
    command: postgresBackupCommand({
      authMountPath,
      backupMountPath,
      filenamePrefix: `${databaseName}-`,
      dateFormat: "%Y%m%d",
      serviceHost,
      owner,
      databaseName,
    }),
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
const softwareFactoryBackup = softwareFactoryProductManifest().backup;
// captive-portal's backup CronJob REMOVED (SDD track 0, Task 6) along with
// its CNPG clusters + namespace; a final pg_dump was taken to the NAS first
// (captive-portal-final-20260721.dump).

/**
 * @public - the declared CronJob set (pure data). nasNfsServer is threaded into
 * the pg-backup NFS PV the same way services.ts threads it into the worker
 * (www-j934.17); the NAS LAN IP by default. imageDigests defaults to {} (plain
 * :main, e.g. local/coldStart applies) and is otherwise the same CI-supplied
 * map services.ts's Deployments pin from. Consumed by deployCrons + the unit
 * tests; no other internal consumer.
 */
export function cronSpecs(
  nasNfsServer: string,
  imageDigests: ImageDigests = {},
): OwnedCronJobSpec[] {
  return [
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
      image: ghcr("map-provision", imageDigests),
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
    postgresBackupCronSpec(softwareFactoryBackup, nasNfsServer),
    softwareFactoryBlobsBackupCronSpec(nasNfsServer),
  ];
}

export interface CronsArgs {
  provider: k8s.Provider;
  namespaces: Readonly<Record<InfraNamespaceName, pulumi.Input<string>>>;
  // NFS server for the NAS backup PV; the NAS LAN IP by default. kubelet mounts
  // the PV from the node netns (reaches the LAN on home-server, DESIGN §5b); the
  // pod-egress no-route limit (§5c) does not apply to PV mounts. www-j934.17.
  nasNfsServer: string;
  // Same CI-supplied digest-pin map as services.ts's deployServices; defaults
  // to {} (plain :main) so existing callers/tests are unaffected.
  imageDigests?: ImageDigests;
}

export interface CronsResources {
  jobs: ScheduledJob[];
}

/**
 * @public - instantiates a ScheduledJob per declared cron. Consumed by the
 * cluster program (program.ts); no other internal consumer in this ticket.
 */
export function deployCrons(args: CronsArgs): CronsResources {
  const { provider, namespaces, nasNfsServer, imageDigests = {} } = args;
  const jobs = cronSpecs(nasNfsServer, imageDigests).map(
    ({ namespaceName, ...spec }) =>
      new ScheduledJob({ ...spec, provider, namespace: namespaces[namespaceName] }, { provider }),
  );
  return { jobs };
}
