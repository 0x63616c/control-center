// CloudNativePG: operator + product-owned single-instance Clusters. Clusters run
// on local-path PVCs on the mini's SSD (NOT NFS: corruption footgun + the DS420+
// is 2GB RAM, RECON decision 5).
//
// Credential bridge (the key correctness point): the app connects as
// postgres@<svc>:5432/<db> with the password declared by the product manifest.
// CNPG must use THAT password, not mint a random one, so migrated data and each
// app's POSTGRES_PASSWORD line up. A native kubernetes.io/basic-auth Secret
// (username "postgres") is created from the SOPS vault (CC-k8t7: replaced ESO
// ExternalSecrets). The Cluster references it via bootstrap.initdb.secret +
// superuserSecret. (Secret must exist before initdb runs; the operator retries.)

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { controlCenterProductManifest, type ProductDatabase } from "@www/platform";
import type { InfraNamespaceName } from "./cluster.ts";

export interface CnpgArgs {
  provider: k8s.Provider;
  namespaces: Readonly<Record<InfraNamespaceName, pulumi.Input<string>>>;
  // CNPG operator install manifest version (www-j934.4 preflight pin: 1.29.1).
  operatorVersion: string;
  // Decrypted vault from vault.ts (CC-k8t7).
  vault: Record<string, string>;
}

export interface CnpgResources {
  operator: k8s.yaml.ConfigFile;
  authSecrets: k8s.core.v1.Secret[];
  clusters: k8s.apiextensions.CustomResource[];
  authSecret: k8s.core.v1.Secret;
  cluster: k8s.apiextensions.CustomResource;
}

// captive-portal's database + retainedLegacyDatabases REMOVED (SDD track 0,
// Task 6): its CNPG clusters + namespace were torn down after a copy of its
// one live row was folded into control_center and a final pg_dump was taken.
// captivePortalProductManifest() itself still exists in @www/platform (pruned
// in Task 7+8), just no longer called from here.
function productDatabases(): ProductDatabase[] {
  return [controlCenterProductManifest().database];
}

function createAuthSecret(
  database: ProductDatabase,
  vault: Record<string, string>,
  namespace: pulumi.Input<string>,
  opts: pulumi.CustomResourceOptions,
): k8s.core.v1.Secret {
  // The postgres password's SOPS vault key comes from the product manifest's
  // database auth declaration (single source, CC-k8t7), not a local copy.
  const vaultKey = database.auth.password.vaultKey;
  const password = vault[vaultKey];
  if (password === undefined) {
    throw new Error(`cnpg: vault key "${vaultKey}" not found`);
  }
  const resourceName = database.authSecretName;
  return new k8s.core.v1.Secret(
    resourceName,
    {
      metadata: { name: database.authSecretName, namespace },
      type: "kubernetes.io/basic-auth",
      stringData: {
        username: database.owner,
        password: pulumi.secret(password),
      },
    },
    opts,
  );
}

function createCluster(
  database: ProductDatabase,
  namespace: pulumi.Input<string>,
  operator: k8s.yaml.ConfigFile,
  authSecret: k8s.core.v1.Secret,
  opts: pulumi.CustomResourceOptions,
): k8s.apiextensions.CustomResource {
  const resourceName = database.clusterName;
  return new k8s.apiextensions.CustomResource(
    resourceName,
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: database.clusterName, namespace },
      spec: {
        instances: 1,
        enableSuperuserAccess: true,
        superuserSecret: { name: database.authSecretName },
        bootstrap: {
          initdb: {
            database: database.databaseName,
            owner: database.owner,
            secret: { name: database.authSecretName },
          },
        },
        storage: { storageClass: database.storageClass, size: database.size },
        resources: database.resources,
      },
    },
    { ...opts, dependsOn: [operator, authSecret] },
  );
}

/**
 * @public - installs the CNPG operator and product-owned single-instance
 * Clusters with bridged credentials. Consumed by the cluster program; app
 * Deployments point DATABASE hosts at the read-write Services CNPG creates.
 */
export function installCnpg(args: CnpgArgs): CnpgResources {
  const { provider, namespaces, operatorVersion, vault } = args;
  const opts = { provider };

  const operator = new k8s.yaml.ConfigFile(
    "cnpg-operator",
    {
      file: `https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-${operatorVersion}.yaml`,
    },
    opts,
  );

  const databases = productDatabases();
  // ProductDatabase.product is typed as the full platform ProductSlug (still
  // includes "captive-portal" , its @www/platform identity survives until
  // Task 7+8), but productDatabases() above only ever returns control-center
  // now, and InfraNamespaceName deliberately excludes "captive-portal" (Task
  // 6 removed its namespace). Cast rather than widen InfraNamespaceName back.
  const authSecrets = databases.map((database) =>
    createAuthSecret(database, vault, namespaces[database.product as InfraNamespaceName], opts),
  );
  const clusters = databases.map((database, index) =>
    createCluster(
      database,
      namespaces[database.product as InfraNamespaceName],
      operator,
      authSecrets[index],
      opts,
    ),
  );

  return { operator, authSecrets, clusters, authSecret: authSecrets[0], cluster: clusters[0] };
}
