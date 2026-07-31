import { __resetEnvCache, ENV } from "@www/platform/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayConfig } from "../src/config";

afterEach(() => {
  vi.unstubAllEnvs();
  __resetEnvCache(ENV);
});

describe("relayConfig", () => {
  it("accepts a second named consumer using configuration only", () => {
    vi.stubEnv("GITHUB_BOT_WEBHOOK_SECRET", "test-secret");
    vi.stubEnv(
      "WEBHOOK_RELAY_TARGETS",
      JSON.stringify([
        {
          name: "control-center",
          url: "http://api.control-center.svc.cluster.local:4201/hooks/github",
        },
        { name: "software-factory", url: "http://software-factory.example/github" },
      ]),
    );
    __resetEnvCache(ENV);
    expect(relayConfig().targets).toHaveLength(2);
    expect(relayConfig().targets[1]?.name).toBe("software-factory");
  });
});
