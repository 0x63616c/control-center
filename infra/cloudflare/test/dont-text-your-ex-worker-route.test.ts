import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, test, vi } from "vitest";

const resources: Array<{
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}> = [];

pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call(args) {
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

describe("Don't Text Your Ex Worker route", () => {
  beforeAll(() => {
    vi.resetModules();
  });

  test("attaches only the exact API route to the separately deployed script", async () => {
    const { createDontTextYourExWorkerRoute } = await import("../src/worker-route.ts");
    const route = createDontTextYourExWorkerRoute({
      zoneId: "secret-zone-id",
      zoneName: "worldwidewebb.co",
    });
    const routeId = await new Promise<string>((resolve) => {
      route.id.apply((value) => {
        resolve(value);
        return value;
      });
    });
    expect(routeId).toBe("dont-text-your-ex-edge-route-id");

    const workerResources = resources.filter((resource) => resource.type.includes("workers"));
    expect(workerResources).toEqual([
      {
        type: "cloudflare:index/workersRoute:WorkersRoute",
        name: "dont-text-your-ex-edge-route",
        inputs: {
          pattern: "dont-text-your-ex.worldwidewebb.co/api/*",
          scriptName: "dont-text-your-ex-edge",
          zoneId: "secret-zone-id",
        },
      },
    ]);
  });

  test("marks only this route recoverable for emergency removal", async () => {
    const { dontTextYourExWorkerRouteOptions } = await import("../src/worker-route.ts");
    expect(dontTextYourExWorkerRouteOptions).toMatchObject({ protect: false });
  });
});
