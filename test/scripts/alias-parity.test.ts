// Resolves via the vitest alias (root vitest.config.ts, apps-gen project). This
// import is the live proof that vitest resolves `@app-kit` identically to tsc
// (tsconfig `paths`), bun (nearest tsconfig `paths`), and vite (resolve.alias).
// If any resolver drops the alias, this file fails to resolve and the run goes
// red. check-alias-parity.sh is the static backstop that greps each config.
import { defineApp } from "@app-kit";
import { expect, it } from "vitest";

it("@app-kit resolves under vitest and exports defineApp", () => {
  expect(typeof defineApp).toBe("function");
});
