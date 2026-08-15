import { describe, expect, test } from "vitest";
import { namespaceLookupState } from "../src/ghcr-pull-secret-preflight.ts";

describe("GHCR pull secret namespace bootstrap", () => {
  test("skips only a confirmed Kubernetes NotFound response", () => {
    expect(
      namespaceLookupState({
        exitCode: 1,
        stdout: "",
        stderr: 'Error from server (NotFound): namespaces "dont-text-your-ex" not found',
      }),
    ).toBe("absent");
  });

  test("does not mistake authentication or network errors for a new namespace", () => {
    expect(namespaceLookupState({ exitCode: 1, stdout: "", stderr: "Unauthorized" })).toBe("error");
    expect(namespaceLookupState({ exitCode: 1, stdout: "", stderr: "connection refused" })).toBe(
      "error",
    );
  });

  test("checks the secret when the namespace exists", () => {
    expect(
      namespaceLookupState({
        exitCode: 0,
        stdout: "namespace/dont-text-your-ex",
        stderr: "",
      }),
    ).toBe("exists");
  });
});
