import { describe, expect, test } from "vitest";
import { defineProduct, defineProductDatabase, homelabTarget } from "../src/index.ts";

describe("product CNPG database primitive", () => {
  test("renders current Control Center CNPG identity without behavior change", () => {
    const database = defineProductDatabase(defineProduct("control-center"), homelabTarget, {
      authSecretName: "cc-postgres-auth",
      clusterName: "control-center",
      rwServiceName: "control-center-rw",
      roServiceName: "control-center-ro",
      readServiceName: "control-center-r",
      size: "5Gi",
    });

    expect(database).toMatchObject({
      authSecretName: "cc-postgres-auth",
      clusterName: "control-center",
      databaseName: "control_center",
      owner: "postgres",
      readServiceName: "control-center-r",
      roServiceName: "control-center-ro",
      rwServiceName: "control-center-rw",
      size: "5Gi",
      storageClass: "local-lvm",
      target: "homelab",
      resources: {
        limits: { memory: "768Mi" },
        requests: { cpu: "500m", memory: "384Mi" },
      },
    });
  });

  test("defaults Kubernetes resources to namespace-local postgres names", () => {
    const database = defineProductDatabase(defineProduct("captive-portal"), homelabTarget, {
      size: "5Gi",
    });

    expect(database.databaseName).toBe("captive_portal");
    expect(database.clusterName).toBe("postgres");
    expect(database.authSecretName).toBe("postgres-auth");
    expect(database.rwServiceName).toBe("postgres-rw");
    expect(database.roServiceName).toBe("postgres-ro");
    expect(database.readServiceName).toBe("postgres-r");
  });

  test("marks database-owned auth separately from service secret usage", () => {
    const database = defineProductDatabase(defineProduct("control-center"), homelabTarget, {
      authSecretName: "cc-postgres-auth",
      size: "5Gi",
    });

    expect(database.auth.kind).toBe("database-owned-basic-auth");
    expect(database.auth.secretName).toBe("cc-postgres-auth");
  });

  test("resolves Software Factory database auth from the secret catalogue", () => {
    const database = defineProductDatabase(defineProduct("software-factory"), homelabTarget, {
      size: "1Gi",
    });

    expect(database).toMatchObject({
      databaseName: "software_factory",
      auth: {
        kind: "database-owned-basic-auth",
        password: { vaultKey: "SOFTWARE_FACTORY_POSTGRES__PASSWORD" },
      },
    });
  });
});
