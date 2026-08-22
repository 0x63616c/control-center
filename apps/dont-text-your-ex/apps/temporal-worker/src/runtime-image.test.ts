import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("DTYE Temporal worker runtime image", () => {
  test("includes source modules loaded by the Temporal workflow bundler", () => {
    const dockerfile = readFileSync(
      new URL("../../../Dockerfile.temporal-worker", import.meta.url),
      "utf8",
    );

    expect(dockerfile).toContain(
      "COPY --from=build /app/apps/dont-text-your-ex/apps/api/src/domain-events.ts apps/dont-text-your-ex/apps/api/src/domain-events.ts",
    );
  });
});
