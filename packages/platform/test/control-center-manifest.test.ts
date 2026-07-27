import { describe, expect, test } from "vitest";
import { cronSpecs } from "../../../infra/src/crons.ts";
import { SERVICE_SECRETS, type ServiceSecrets } from "../../../infra/src/secrets-map.ts";
import { controlCenterProductManifest, serviceSecretMap } from "../src/index.ts";

describe("Control Center platform representation", () => {
  test("declares Control Center app identity and target app surface", () => {
    const manifest = controlCenterProductManifest();

    expect(manifest.product.slug).toBe("control-center");
    expect(manifest.app.exposure.hostname).toBe("app.worldwidewebb.co");
  });

  test("declares every Control Center service the manifest owns", () => {
    const manifest = controlCenterProductManifest();
    const serviceNames = Object.values(manifest.services)
      .map((service) => service.service)
      .sort();

    expect(serviceNames).toEqual([
      "api",
      "captive-portal",
      "cloudflared",
      "storybook",
      "web",
      "worker",
    ]);
  });

  test("keeps current service secret usage exactly representable (CC-k8t7: env names only, values now vault keys)", () => {
    const manifest = controlCenterProductManifest();
    // SERVICE_SECRETS values are now vault keys (CC-k8t7). Assert env-name set only.
    const ccMap = serviceSecretMap(manifest.secretUsages);
    const infraSecretMap = SERVICE_SECRETS as Record<string, ServiceSecrets>;
    for (const [service, platformSecrets] of Object.entries(ccMap)) {
      const infraKeys = Object.keys(infraSecretMap[service] ?? {}).sort();
      const platformKeys = Object.keys(platformSecrets).sort();
      expect(infraKeys).toEqual(platformKeys);
    }
  });

  test("keeps current database and backup behavior representable", () => {
    const manifest = controlCenterProductManifest();
    const backupCron = cronSpecs("192.168.0.218").find((cron) => cron.name === "pg-backup");

    expect(manifest.database).toMatchObject({
      authSecretName: "cc-postgres-auth",
      clusterName: "control-center-postgres",
      databaseName: "control_center",
      rwServiceName: "control-center-postgres-rw",
    });
    expect(manifest.backup).toMatchObject({
      name: backupCron?.name,
      schedule: backupCron?.schedule,
      databaseName: "control_center",
      serviceHost: "control-center-postgres-rw",
      nasSubPath: "backups/postgres",
    });
  });
});
