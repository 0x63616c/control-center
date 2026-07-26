// The per-service secret inventory consumed by eso.ts (native k8s Secrets) and
// vault.ts. This file is now a thin ADAPTER: the single declaration lives in the
// @www/platform product manifest (secretCatalog + the per-service secretUsages),
// and the two maps below are DERIVED from it. Each secret value is a VAULT_KEY in
// secrets/vault.yaml (ITEM__FIELD format); vault.ts reads the vault and creates a
// native k8s Secret per service (CC-k8t7: migrated from ESO+1Password to SOPS+age).
//
// Adding/removing a service secret is a one-line edit in the platform manifest;
// SERVICE_SECRETS, SERVICE_SECRET_TARGETS, and the services.ts mount markers all
// follow. infra/test/secrets-derivation.test.ts pins the exact expected content
// as a golden snapshot so any drift fails loudly.

import {
  controlCenterServiceSecretUsages,
  type ServiceSecretUsage,
  serviceSecretMap,
} from "@www/platform";
import type { InfraNamespaceName } from "./cluster.ts";

/** A service's secret env-name -> VAULT_KEY in secrets/vault.yaml. */
export type ServiceSecrets = Record<string, string>;

// The infra/eso service keys mapped to their platform manifest usage. The
// control-center usage names are 1:1 with the infra keys.
// web / storybook / captive-portal(app) have NO secrets and are absent on
// purpose. The captive-portal-api eso service key was REMOVED (Task 4 step C,
// SDD track 0): its workload (services.ts) was deleted once the guest
// listener cutover moved all guest traffic onto control-center-api, so its
// vault-derived Secret ("captive-portal-secrets-api") is now unused , this
// next apply deletes it (a Secret holding credentials, not user data). The
// captive-portal CNPG database + namespace were later torn down entirely in
// Task 6 (its one live row was copied into control_center + a final pg_dump
// taken first).
const controlCenterUsages = controlCenterServiceSecretUsages();

const serviceSecretUsages = {
  api: controlCenterUsages.api,
  worker: controlCenterUsages.worker,
  cloudflared: controlCenterUsages.cloudflared,
  "portal-data-purge": controlCenterUsages["portal-data-purge"],
} as const satisfies Record<string, ServiceSecretUsage>;

/**
 * @public - the secret inventory per k8s workload, DERIVED from the platform
 * manifest. Consumed by eso.ts to emit one native k8s Secret per service.
 */
export const SERVICE_SECRETS = serviceSecretMap(serviceSecretUsages) satisfies Record<
  string,
  ServiceSecrets
>;

export type ServiceSecretName = keyof typeof serviceSecretUsages;

export type ServiceSecretTarget = Readonly<{
  namespaceName: InfraNamespaceName;
  secretName: string;
}>;

function targetOf(usage: ServiceSecretUsage): ServiceSecretTarget {
  // usage.namespaceName is platform-typed broadly (still allows
  // "captive-portal", kept alive in @www/platform until Task 7+8), but every
  // usage actually wired below (serviceSecretUsages, all control-center) is
  // control-center-scoped; InfraNamespaceName excludes "captive-portal" post
  // Task 6 (its namespace is gone).
  return {
    namespaceName: usage.namespaceName as InfraNamespaceName,
    secretName: usage.targetSecretName,
  };
}

/**
 * @public - the target namespace + Secret name per workload, DERIVED from the
 * platform manifest usages. Consumed by eso.ts/vault.ts/services.ts/crons.ts.
 */
export const SERVICE_SECRET_TARGETS = {
  api: targetOf(serviceSecretUsages.api),
  worker: targetOf(serviceSecretUsages.worker),
  cloudflared: targetOf(serviceSecretUsages.cloudflared),
  "portal-data-purge": targetOf(serviceSecretUsages["portal-data-purge"]),
} as const satisfies Record<ServiceSecretName, ServiceSecretTarget>;
