import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "dont-text-your-ex-frontend",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
