import { describe, expect, test } from "vitest";
import { defineProduct, productSlugs } from "../src/index.ts";

describe("product identity", () => {
  test("defines the platform products", () => {
    expect(productSlugs).toEqual(["control-center", "captive-portal", "software-factory"]);
  });

  test("retains software-factory deployment digest identity", () => {
    const factory = defineProduct("software-factory");

    expect(factory.imageDigestKey("worker")).toBe("software-factory-worker");
    expect(factory.imageDigestKey("run-worker")).toBe("software-factory-run-worker");
  });

  test("derives Control Center identity from the product slug", () => {
    const app = defineProduct("control-center");

    expect(app.slug).toBe("control-center");
    expect(app.folder).toBe("products/control-center");
    expect(app.namespace).toBe("control-center");
    expect(app.imageNamespace).toBe("control-center");
    expect(app.pulumiName("api")).toBe("control-center-api");
    expect(app.serviceName("api")).toBe("control-center-api");
    expect(app.imageRepository("api")).toBe("ghcr.io/0x63616c/www-control-center-api");
    expect(app.imageDigestKey("api")).toBe("control-center-api");
    expect(app.backupPathParts("postgres")).toEqual([
      "backups",
      "world-wide-webb",
      "control-center",
      "postgres",
    ]);
    expect(app.labels("api")).toEqual({
      "app.kubernetes.io/component": "api",
      "app.kubernetes.io/name": "control-center",
      "app.kubernetes.io/part-of": "world-wide-webb",
      "worldwidewebb.co/product": "control-center",
    });
  });

  test.each([
    ["captive-portal", "ghcr.io/0x63616c/www-captive-portal-api", "captive-portal-api"],
  ] as const)("derives full-slug global naming for %s", (slug, imageRepository, imageDigestKey) => {
    const app = defineProduct(slug);

    expect(app.namespace).toBe(slug);
    expect(app.folder).toBe(`products/${slug}`);
    expect(app.imageRepository("api")).toBe(imageRepository);
    expect(app.imageDigestKey("api")).toBe(imageDigestKey);
  });
});
