import { describe, expect, test } from "vitest";
import { cronSpecs } from "../src/crons.ts";
import {
  assertGhcrPullSecretNamespaceCoverage,
  collectGhcrPullSecretNamespaces,
  GHCR_PULL_SECRET_NAME,
  GHCR_PULL_SECRET_NAMESPACES,
} from "../src/ghcr-pull-secrets.ts";
import { type ImageDigests, serviceSpecs } from "../src/services.ts";

const specsWith = (imageDigests?: ImageDigests): ReturnType<typeof serviceSpecs> =>
  serviceSpecs({
    cloudflaredReplicas: 2,
    nasNfsServer: "192.168.0.218",
    imageDigests,
  });

describe("GHCR pull secret coverage", () => {
  test("declares the pull secret in every namespace with GHCR services or cron jobs", () => {
    const consumers = [...specsWith(), ...cronSpecs("192.168.0.218")];
    expect(collectGhcrPullSecretNamespaces(consumers)).toEqual(["control-center"]);
    expect(() => assertGhcrPullSecretNamespaceCoverage(consumers)).not.toThrow();
  });

  test("does not require the secret in namespaces with only public upstream images", () => {
    const cloudflared = specsWith().find((spec) => spec.logicalName === "platform-cloudflared");
    expect(cloudflared?.namespaceName).toBe("platform");
    expect(cloudflared?.imagePullSecrets).toBeUndefined();
    expect(GHCR_PULL_SECRET_NAMESPACES).not.toContain("platform");
  });

  test("fails when a new GHCR namespace is not added to the preflight list", () => {
    expect(() =>
      assertGhcrPullSecretNamespaceCoverage([
        { namespaceName: "platform", imagePullSecrets: [GHCR_PULL_SECRET_NAME] },
      ]),
    ).toThrow(/missing from secret list: platform/);
  });
});
