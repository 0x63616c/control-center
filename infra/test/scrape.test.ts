import { describe, expect, test } from "vitest";
import type { WorkloadSpec } from "../src/component.ts";
import { renderWorkload } from "../src/component.ts";

// #214: `scrape` is the workload seam Prometheus discovers targets through.
// The whole point of the field is WHERE it renders — pod SD never looks at a
// Deployment object — so that placement is what these tests pin.

const base: WorkloadSpec = {
  name: "api",
  image: "ghcr.io/0x63616c/www-control-center-api:main",
  replicas: 1,
};

describe("renderWorkload: scrape annotations (#214)", () => {
  test("lands the prometheus.io/* annotations on the POD TEMPLATE, not the Deployment", () => {
    const r = renderWorkload({ ...base, scrape: { port: 9464 } });
    expect(r.deployment.spec.template.metadata.annotations).toEqual({
      "prometheus.io/scrape": "true",
      "prometheus.io/port": "9464",
      "prometheus.io/path": "/metrics",
    });
    // Deployment metadata must stay clean: an annotation here is invisible to
    // `role: pod` service discovery, which is the bug this field exists to fix.
    expect(r.deployment.metadata.annotations).toBeUndefined();
  });

  test("path defaults to /metrics and is overridable", () => {
    const r = renderWorkload({ ...base, scrape: { port: 4201, path: "/internal/metrics" } });
    expect(r.deployment.spec.template.metadata.annotations?.["prometheus.io/path"]).toBe(
      "/internal/metrics",
    );
  });

  test("no scrape declared means no pod annotations at all", () => {
    const r = renderWorkload(base);
    expect(r.deployment.spec.template.metadata.annotations).toBeUndefined();
  });

  test("the existing Deployment-level `annotations` field is untouched by scrape", () => {
    const r = renderWorkload({
      ...base,
      annotations: { "pulumi.com/skipAwait": "true" },
      scrape: { port: 9464 },
    });
    // Deployment keeps ONLY its own annotations (the provider's await-control
    // keys must not leak onto pods, and scrape must not leak onto the Deployment).
    expect(r.deployment.metadata.annotations).toEqual({ "pulumi.com/skipAwait": "true" });
    expect(r.deployment.spec.template.metadata.annotations).toEqual({
      "prometheus.io/scrape": "true",
      "prometheus.io/port": "9464",
      "prometheus.io/path": "/metrics",
    });
  });

  test("the metrics port is never turned into a Service (in-cluster scrape only)", () => {
    // Pod-IP scraping needs no Service; for the api a Service port would also be
    // reachable through the Cloudflare tunnel, which metrics must never be.
    const r = renderWorkload({ ...base, scrape: { port: 9464 } });
    expect(r.services).toHaveLength(0);
  });
});
